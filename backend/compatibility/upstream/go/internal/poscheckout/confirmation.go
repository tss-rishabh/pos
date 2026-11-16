// Package poscheckout owns the POS ordinary-checkout projection boundary. The
// callback is the extracted original allocation body bound to this transaction.
// No HTTP, logger, application initialization or automatic side-effect retry is
// part of this package.
package poscheckout

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"sort"
	"strings"
)

const Contract = "pos-checkout-projection-v1"

var ErrReview = errors.New("POS checkout projection requires reconciliation")
var ErrLegacyCashback = errors.New("legacy cashback allocation requires an approved wallet policy")

type HashContract struct {
	// These expressions are fixed, reviewed source constants, never request data.
	HeaderSQL string
	LineSQL   string
}
type Apply func(*sql.Tx) error
type Confirmation struct {
	Created                    bool
	UserID, StoreID, CounterID int64
	ProductIDs                 []int64
}
type Line struct {
	ID, ProductID, Quantity int64
	InputHash               string
}

// Confirm serializes the order, customer wallet, used voucher and all store
// stock rows, then commits source allocations, statuses and proof together.
// A lost commit response is recovered by validating the durable proof. An old
// placed/paid order without proof is never deducted again.
func Confirm(ctx context.Context, db *sql.DB, orderID int64, hashes HashContract, apply Apply) (Confirmation, error) {
	if orderID < 1 || apply == nil || hashes.HeaderSQL == "" || hashes.LineSQL == "" {
		return Confirmation{}, ErrReview
	}
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return Confirmation{}, err
	}
	defer tx.Rollback()
	var userID, method, paid, status, voucherID, parentID, originalID, hlParentID, locationID, couponID int64
	var cashback, money, points float32
	var voucherAmount, payable float64
	if err = tx.QueryRowContext(ctx, `SELECT user_id,payment_method,payment_status,order_status,cashback_used,tss_money_used,tss_points_used,voucher_used,COALESCE(voucher_amt_used,0),COALESCE(parent_order_id,0),COALESCE(original_order_id,0),COALESCE(hl_parent_order_id,0),COALESCE(location_id,0),pay_amt,COALESCE(coupon_used,0) FROM orders WHERE id=? FOR UPDATE`, orderID).Scan(&userID, &method, &paid, &status, &cashback, &money, &points, &voucherID, &voucherAmount, &parentID, &originalID, &hlParentID, &locationID, &payable, &couponID); err != nil {
		return Confirmation{}, err
	}
	if userID < 1 || (method != 14 && method != 3) || (method == 3 && payable != 0) || parentID != 0 || originalID != 0 || hlParentID != 0 || locationID != 0 || payable < 0 || money < 0 || points < 0 || voucherAmount < 0 {
		return Confirmation{}, ErrReview
	}
	if cashback != 0 {
		return Confirmation{}, ErrLegacyCashback
	}
	rows, err := tx.QueryContext(ctx, `SELECT store_id,counter_id FROM order_stores WHERE order_id=? FOR UPDATE`, orderID)
	if err != nil {
		return Confirmation{}, err
	}
	var storeID, counterID int64
	if !rows.Next() {
		err = rows.Err()
		rows.Close()
		if err != nil {
			return Confirmation{}, err
		}
		return Confirmation{}, ErrReview
	}
	if err = rows.Scan(&storeID, &counterID); err != nil {
		rows.Close()
		return Confirmation{}, err
	}
	duplicate := rows.Next()
	readErr := rows.Err()
	closeErr := rows.Close()
	if readErr != nil {
		return Confirmation{}, readErr
	}
	if closeErr != nil {
		return Confirmation{}, closeErr
	}
	if duplicate || storeID < 1 || counterID < 1 {
		return Confirmation{}, ErrReview
	}
	items, err := tx.QueryContext(ctx, `SELECT has_products.id,has_products.prod_id,has_products.qty,`+hashes.LineSQL+`,has_products.status FROM has_products WHERE has_products.order_id=? ORDER BY has_products.id FOR UPDATE`, orderID)
	if err != nil {
		return Confirmation{}, err
	}
	var lines []Line
	allIncomplete := true
	stockQuantities := map[int64]int64{}
	for items.Next() {
		var line Line
		var initialStatus string
		if err = items.Scan(&line.ID, &line.ProductID, &line.Quantity, &line.InputHash, &initialStatus); err != nil {
			items.Close()
			return Confirmation{}, err
		}
		if initialStatus != "INCOMPLETE" {
			allIncomplete = false
		}
		if line.ID < 1 || line.ProductID < 1 || line.Quantity < 1 || line.Quantity > 999 || len(line.InputHash) != 64 {
			items.Close()
			return Confirmation{}, ErrReview
		}
		lines = append(lines, line)
		stockQuantities[line.ProductID] += line.Quantity
	}
	readErr = items.Err()
	closeErr = items.Close()
	if readErr != nil {
		return Confirmation{}, readErr
	}
	if closeErr != nil {
		return Confirmation{}, closeErr
	}
	if len(lines) < 1 || len(lines) > 1000 {
		return Confirmation{}, ErrReview
	}
	var moneyBalance, pointsBalance float32
	var customerStatus int
	var customerBlocked, customerDisabled sql.NullInt64
	if err = tx.QueryRowContext(ctx, `SELECT tss_money,tss_points,status,is_block,is_disabled FROM users WHERE id=? FOR UPDATE`, userID).Scan(&moneyBalance, &pointsBalance, &customerStatus, &customerBlocked, &customerDisabled); err != nil {
		return Confirmation{}, err
	}
	if customerStatus != 1 || (customerBlocked.Valid && customerBlocked.Int64 != 0) || (customerDisabled.Valid && customerDisabled.Int64 != 0) {
		return Confirmation{}, ErrReview
	}
	proof, err := readProof(ctx, tx, orderID)
	if err == nil {
		if proof.UserID != userID || proof.StoreID != storeID || proof.CounterID != counterID || proof.Version != Contract || proof.LineCount != len(lines) || (status != 1 && status != 3) || (paid != 1 && paid != 4) || (method == 3 && (status != 3 || paid != 4)) {
			return Confirmation{}, ErrReview
		}
		var header string
		if err = tx.QueryRowContext(ctx, `SELECT `+hashes.HeaderSQL+` FROM orders WHERE orders.id=?`, orderID).Scan(&header); err != nil {
			return Confirmation{}, err
		}
		if header != proof.InputHash {
			return Confirmation{}, ErrReview
		}
		if _, err = lockMembership(ctx, tx, orderID, userID, header, lines, true); err != nil {
			return Confirmation{}, err
		}
		if err = verifyCustomerConsentProof(ctx, tx, orderID, userID, storeID, counterID, header, money, points, voucherAmount); err != nil {
			return Confirmation{}, err
		}
		if err = verifyLines(ctx, tx, orderID, lines); err != nil {
			return Confirmation{}, err
		}
		if paid == 4 {
			err = verifyGiftCardIssuances(ctx, tx, orderID)
		} else {
			_, err = lockPendingGiftCards(ctx, tx, orderID)
		}
		if err != nil {
			return Confirmation{}, err
		}
		if err = tx.Commit(); err != nil {
			return Confirmation{}, err
		}
		return confirmation(false, userID, storeID, counterID, stockQuantities), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return Confirmation{}, err
	}
	if paid != 0 || status != 0 || !allIncomplete {
		return Confirmation{}, ErrReview
	}
	if money > moneyBalance || points > pointsBalance {
		return Confirmation{}, ErrReview
	}
	var originalHeader string
	if err = tx.QueryRowContext(ctx, `SELECT `+hashes.HeaderSQL+` FROM orders WHERE orders.id=?`, orderID).Scan(&originalHeader); err != nil {
		return Confirmation{}, err
	}
	membership, err := lockMembership(ctx, tx, orderID, userID, originalHeader, lines, false)
	if err != nil {
		return Confirmation{}, err
	}
	consent, err := consentBeforeMutation(ctx, tx, orderID, userID, storeID, counterID, couponID, money, points, voucherAmount)
	if err != nil {
		return Confirmation{}, err
	}
	if voucherID > 0 {
		var value float64
		var active int
		if err = tx.QueryRowContext(ctx, `SELECT voucher_value,status FROM gift_vouchers WHERE id=? FOR UPDATE`, voucherID).Scan(&value, &active); err != nil {
			return Confirmation{}, err
		}
		if active != 1 || voucherAmount > value {
			return Confirmation{}, ErrReview
		}
	} else if voucherAmount != 0 {
		return Confirmation{}, ErrReview
	}
	cards, err := lockPendingGiftCards(ctx, tx, orderID)
	if err != nil {
		return Confirmation{}, err
	}
	var products []int64
	for id := range stockQuantities {
		products = append(products, id)
	}
	sort.Slice(products, func(i, j int) bool { return products[i] < products[j] })
	for _, productID := range products {
		stocks, e := tx.QueryContext(ctx, `SELECT id,stock,is_avail,is_del FROM product_store WHERE store_id=? AND product_id=? FOR UPDATE`, storeID, productID)
		if e != nil {
			return Confirmation{}, e
		}
		var id, stock int64
		var available, deleted bool
		if !stocks.Next() {
			e = stocks.Err()
			stocks.Close()
			if e != nil {
				return Confirmation{}, e
			}
			return Confirmation{}, ErrReview
		}
		if e = stocks.Scan(&id, &stock, &available, &deleted); e != nil {
			stocks.Close()
			return Confirmation{}, e
		}
		duplicate = stocks.Next()
		readErr = stocks.Err()
		closeErr = stocks.Close()
		if readErr != nil {
			return Confirmation{}, readErr
		}
		if closeErr != nil {
			return Confirmation{}, closeErr
		}
		if duplicate || id < 1 || !available || deleted || stock < stockQuantities[productID] {
			return Confirmation{}, ErrReview
		}
	}
	if err = applySafely(tx, apply); err != nil {
		return Confirmation{}, err
	}
	var finalPaid, finalStatus int64
	if err = tx.QueryRowContext(ctx, `SELECT payment_status,order_status FROM orders WHERE id=?`, orderID).Scan(&finalPaid, &finalStatus); err != nil {
		return Confirmation{}, err
	}
	if (method == 14 && (finalPaid != 1 || finalStatus != 1)) || (method == 3 && (finalPaid != 4 || finalStatus != 3)) {
		return Confirmation{}, ErrReview
	}
	if err = verifyAppliedLines(ctx, tx, orderID, method, lines, hashes.LineSQL); err != nil {
		return Confirmation{}, err
	}
	if err = verifyWalletAllocations(ctx, tx, orderID, money, points); err != nil {
		return Confirmation{}, err
	}
	if err = recordGiftCardIssuances(ctx, tx, orderID, method, cards); err != nil {
		return Confirmation{}, err
	}
	var header string
	if err = tx.QueryRowContext(ctx, `SELECT `+hashes.HeaderSQL+` FROM orders WHERE orders.id=?`, orderID).Scan(&header); err != nil {
		return Confirmation{}, err
	}
	if header != originalHeader {
		return Confirmation{}, ErrReview
	}
	if err = finishMembership(ctx, tx, membership); err != nil {
		return Confirmation{}, err
	}
	if err = recordCustomerConsent(ctx, tx, orderID, userID, storeID, counterID, header, consent); err != nil {
		return Confirmation{}, err
	}
	var parameters []interface{}
	var placeholders []string
	for _, line := range lines {
		placeholders = append(placeholders, "(?,?,?,?,?)")
		parameters = append(parameters, orderID, line.ID, line.ProductID, line.Quantity, line.InputHash)
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_checkout_projection_lines(order_id,has_product_id,product_id,quantity,input_hash) VALUES `+strings.Join(placeholders, ","), parameters...); err != nil {
		return Confirmation{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_checkout_projections(order_id,store_id,counter_id,user_id,input_hash,line_count,contract_version,confirmed_at) VALUES(?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`, orderID, storeID, counterID, userID, header, len(lines), Contract); err != nil {
		return Confirmation{}, fmt.Errorf("checkout projection proof: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return Confirmation{}, err
	}
	return confirmation(true, userID, storeID, counterID, stockQuantities), nil
}
func applySafely(tx *sql.Tx, apply Apply) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrReview
		}
	}()
	return apply(tx)
}
func verifyWalletAllocations(ctx context.Context, tx *sql.Tx, orderID int64, money, points float32) error {
	for _, input := range []struct {
		table string
		used  float32
	}{{"order_tss_money", money}, {"order_tss_point", points}} {
		var allocated float32
		if err := tx.QueryRowContext(ctx, `SELECT COALESCE(SUM(used_amount),0) FROM `+input.table+` WHERE order_id=?`, orderID).Scan(&allocated); err != nil {
			return err
		}
		// The source multiplies in float32 before converting to float64 for its
		// two-decimal ledger boundary. Keep that exact boundary on both operands.
		if math.Round(float64(allocated*100)) != math.Round(float64(input.used*100)) {
			return ErrReview
		}
	}
	return nil
}
func verifyAppliedLines(ctx context.Context, tx *sql.Tx, orderID, method int64, expected []Line, hashSQL string) error {
	rows, err := tx.QueryContext(ctx, `SELECT has_products.id,has_products.prod_id,has_products.qty,`+hashSQL+`,has_products.status FROM has_products WHERE has_products.order_id=? ORDER BY has_products.id`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	status := "PLACED"
	if method == 3 {
		status = "DELIVERED"
	}
	for rows.Next() {
		var line Line
		var actualStatus string
		if err = rows.Scan(&line.ID, &line.ProductID, &line.Quantity, &line.InputHash, &actualStatus); err != nil {
			return err
		}
		if index >= len(expected) || line != expected[index] || actualStatus != status {
			return ErrReview
		}
		index++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if index != len(expected) {
		return ErrReview
	}
	return nil
}

type proof struct {
	UserID, StoreID, CounterID int64
	InputHash, Version         string
	LineCount                  int
}

func readProof(ctx context.Context, tx *sql.Tx, orderID int64) (proof, error) {
	var value proof
	// The existing order record serializes proof writers. A missing proof is
	// deliberately not gap-locked, avoiding cross-order insertion deadlocks.
	err := tx.QueryRowContext(ctx, `SELECT user_id,store_id,counter_id,input_hash,line_count,contract_version FROM pos_rewrite_checkout_projections WHERE order_id=?`, orderID).Scan(&value.UserID, &value.StoreID, &value.CounterID, &value.InputHash, &value.LineCount, &value.Version)
	return value, err
}
func verifyLines(ctx context.Context, tx *sql.Tx, orderID int64, lines []Line) error {
	rows, err := tx.QueryContext(ctx, `SELECT has_product_id,product_id,quantity,input_hash FROM pos_rewrite_checkout_projection_lines WHERE order_id=? ORDER BY has_product_id`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var line Line
		if err = rows.Scan(&line.ID, &line.ProductID, &line.Quantity, &line.InputHash); err != nil {
			return err
		}
		if index >= len(lines) || line != lines[index] {
			return ErrReview
		}
		index++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if index != len(lines) {
		return ErrReview
	}
	return nil
}
func confirmation(created bool, userID, storeID, counterID int64, products map[int64]int64) Confirmation {
	result := Confirmation{Created: created, UserID: userID, StoreID: storeID, CounterID: counterID}
	for id := range products {
		result.ProductIDs = append(result.ProductIDs, id)
	}
	sort.Slice(result.ProductIDs, func(i, j int) bool { return result.ProductIDs[i] < result.ProductIDs[j] })
	return result
}
