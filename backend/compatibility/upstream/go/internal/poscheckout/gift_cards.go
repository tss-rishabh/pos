package poscheckout

import (
	"context"
	"database/sql"
	"math"
	"sort"
	"strconv"
	"strings"
)

const GiftCardIssuanceContract = "pos-gift-card-issuance-v1"
const GiftCardIssuanceHashSQL = "LOWER(SHA2(CAST(JSON_OBJECT('voucher_id',gift_vouchers.id,'order_id',gift_vouchers.order_id,'customer_id',gift_vouchers.from_id,'collection_id',gift_vouchers.collection_no,'serial',gift_vouchers.gift_card_srno,'voucher_code',gift_vouchers.voucher_code,'initial_value',gift_vouchers.voucher_initial_value,'start_date',gift_vouchers.start_date,'end_date',gift_vouchers.end_date) AS CHAR CHARACTER SET utf8mb4),256))"

type giftCard struct {
	ID, CollectionID, Serial    int64
	Value                       sql.NullFloat64
	Status                      int
	CustomerID, OrderCustomerID int64
	InputHash                   string
}

func readGiftCards(ctx context.Context, tx *sql.Tx, orderID int64, lock bool) ([]giftCard, error) {
	query := `SELECT gift_vouchers.id,collection_no,gift_card_srno,voucher_initial_value,gift_vouchers.status,from_id,orders.user_id,` + GiftCardIssuanceHashSQL + ` FROM gift_vouchers JOIN orders ON orders.id=gift_vouchers.order_id WHERE gift_vouchers.order_id=? AND gv_type='GIFT_CARD' ORDER BY gift_vouchers.id LIMIT 101`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := tx.QueryContext(ctx, query, orderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var result []giftCard
	for rows.Next() {
		var card giftCard
		if err = rows.Scan(&card.ID, &card.CollectionID, &card.Serial, &card.Value, &card.Status, &card.CustomerID, &card.OrderCustomerID, &card.InputHash); err != nil {
			return nil, err
		}
		if card.ID < 1 || card.CollectionID < 1 || card.Serial < 1 || card.CustomerID < 1 || card.CustomerID != card.OrderCustomerID || !card.Value.Valid || math.IsNaN(card.Value.Float64) || math.IsInf(card.Value.Float64, 0) || card.Value.Float64 <= 0 || (card.Status != 0 && card.Status != 1) || len(card.InputHash) != 64 {
			return nil, ErrReview
		}
		result = append(result, card)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(result) > 100 {
		return nil, ErrReview
	}
	return result, nil
}

func giftCardSerialParts(serial int64) (collectionID, index int64, err error) {
	value := strconv.FormatInt(serial, 10)
	zero := strings.IndexByte(value, '0')
	if len(value) < 6 || zero < 2 || value[zero-2] != '9' {
		return 0, 0, ErrReview
	}
	after := value[zero+1:]
	if len(after) < 3 || after[0] < '1' || after[0] > '9' {
		return 0, 0, ErrReview
	}
	width := int(after[0] - '0')
	if len(after) <= width+1 {
		return 0, 0, ErrReview
	}
	collectionID, err = strconv.ParseInt(after[len(after)-width:], 10, 64)
	if err != nil || collectionID < 1 {
		return 0, 0, ErrReview
	}
	indexText := after[1 : len(after)-width]
	if indexText[0] == '0' {
		return 0, 0, ErrReview
	}
	index, err = strconv.ParseInt(indexText, 10, 64)
	if err != nil || index < 1 {
		return 0, 0, ErrReview
	}
	return collectionID, index, nil
}

// Match API-v2 creation and batch block: collection rows first, vouchers second.
func lockPendingGiftCards(ctx context.Context, tx *sql.Tx, orderID int64) ([]giftCard, error) {
	before, err := readGiftCards(ctx, tx, orderID, false)
	if err != nil {
		return nil, err
	}
	ids, sizes := []int64{}, map[int64]int{}
	for _, card := range before {
		if _, exists := sizes[card.CollectionID]; !exists {
			ids = append(ids, card.CollectionID)
			sizes[card.CollectionID] = 0
		}
	}
	sort.Slice(ids, func(i, j int) bool { return ids[i] < ids[j] })
	for _, id := range ids {
		var size, complete, blocked, printed int
		if err = tx.QueryRowContext(ctx, `SELECT size,is_completed,is_block,is_printed FROM gift_card_collection WHERE id=? FOR UPDATE`, id).Scan(&size, &complete, &blocked, &printed); err != nil {
			return nil, err
		}
		if size < 1 || complete != 1 || blocked != 0 || printed != 1 {
			return nil, ErrReview
		}
		sizes[id] = size
	}
	current, err := readGiftCards(ctx, tx, orderID, true)
	if err != nil {
		return nil, err
	}
	if len(current) != len(before) {
		return nil, ErrReview
	}
	for index, card := range current {
		collection, serialIndex, parseErr := giftCardSerialParts(card.Serial)
		if parseErr != nil || collection != card.CollectionID || serialIndex > int64(sizes[collection]) || card.Status != 0 || card.ID != before[index].ID || card.InputHash != before[index].InputHash {
			return nil, ErrReview
		}
	}
	var existing int
	if err = tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM pos_rewrite_gift_card_issuances WHERE order_id=?`, orderID).Scan(&existing); err != nil {
		return nil, err
	}
	if existing != 0 {
		return nil, ErrReview
	}
	return current, nil
}

func recordGiftCardIssuances(ctx context.Context, tx *sql.Tx, orderID, method int64, expected []giftCard) error {
	current, err := readGiftCards(ctx, tx, orderID, true)
	if err != nil {
		return err
	}
	if len(current) != len(expected) {
		return ErrReview
	}
	status := 0
	if method == 3 {
		status = 1
	}
	for index, card := range current {
		if card.Status != status || card.ID != expected[index].ID || card.InputHash != expected[index].InputHash {
			return ErrReview
		}
		if method == 3 {
			if _, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_gift_card_issuances(voucher_id,order_id,collection_id,serial,input_hash,contract_version,activated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP)`, card.ID, orderID, card.CollectionID, card.Serial, card.InputHash, GiftCardIssuanceContract); err != nil {
				return err
			}
		}
	}
	return nil
}

func verifyGiftCardIssuances(ctx context.Context, tx *sql.Tx, orderID int64) error {
	cards, err := readGiftCards(ctx, tx, orderID, true)
	if err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, `SELECT voucher_id,collection_id,serial,input_hash,contract_version FROM pos_rewrite_gift_card_issuances WHERE order_id=? ORDER BY voucher_id LIMIT 101 FOR UPDATE`, orderID)
	if err != nil {
		return err
	}
	defer rows.Close()
	index := 0
	for rows.Next() {
		var id, collection, serial int64
		var hash, contract string
		if err = rows.Scan(&id, &collection, &serial, &hash, &contract); err != nil {
			return err
		}
		if index >= len(cards) || id != cards[index].ID || collection != cards[index].CollectionID || serial != cards[index].Serial || hash != cards[index].InputHash || contract != GiftCardIssuanceContract {
			return ErrReview
		}
		index++
	}
	if err = rows.Err(); err != nil {
		return err
	}
	if index != len(cards) {
		return ErrReview
	}
	return nil
}
