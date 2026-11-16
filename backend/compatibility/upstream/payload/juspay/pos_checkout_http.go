package juspay

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"backend-tss-domestic_payments_api/utils"
	"github.com/gin-gonic/gin"
	"github.com/jinzhu/gorm"
)

// Called after source ownership authorization, before CreateCustomer or an
// asynchronous confirmation branch. Online orders and the separate proved POS
// exchange adapter retain their own paths.
func tryConfirmPOSCheckout(c *gin.Context, order *Order) bool {
	if order.ParentOrderId > 0 {
		return false
	}
	database := utils.Db.DB()
	var storeID int64
	err := database.QueryRowContext(c.Request.Context(), `SELECT store_id FROM order_stores WHERE order_id=?`, order.ID).Scan(&storeID)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		return posCheckoutRejected(c)
	}
	if storeID < 1 {
		return false
	}
	if order.PaymentMethod != PaymentMethodCOC && order.PaymentMethod != PaymentMethodPrepaid {
		return false
	}
	if !poscheckout.ProjectionAuthorized(c.Request.Context()) {
		c.JSON(http.StatusUnauthorized, gin.H{"status": http.StatusUnauthorized, "message": "POS projection authorization required."})
		return true
	}
	if _, err = poscheckout.HTTPHandlers(os.Getenv, false); err != nil {
		return posCheckoutRejected(c)
	}
	requestID := c.GetHeader("X-Request-ID")
	if !regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`).MatchString(requestID) {
		requestID = newPOSCheckoutRequestID()
	}
	var operatorID *int64
	if raw := c.GetHeader("X-POS-Operator-ID"); raw != "" {
		value, parseErr := strconv.ParseInt(raw, 10, 64)
		if parseErr != nil || value < 1 || !regexp.MustCompile(`^[1-9]\d{0,18}$`).MatchString(raw) {
			return posCheckoutRejected(c)
		}
		operatorID = &value
	}
	confirmation, err := confirmPOSCheckout(c.Request.Context(), database, order, requestID, operatorID)
	if err != nil {
		return posCheckoutRejected(c)
	}
	if confirmation.UserID != int64(order.User) || confirmation.StoreID != storeID {
		return posCheckoutRejected(c)
	}
	c.JSON(http.StatusCreated, gin.H{"status": http.StatusCreated, "message": "/thank-you"})
	return true
}

// Every source callback/cron entry must use the same serialized projection. A
// caller with a transaction cannot ask this adapter to commit an outer unit of
// work; it fails closed rather than falling back to the unsafe source writes.
func tryConfirmPOSCheckoutInternal(order *Order, database *gorm.DB) (bool, bool) {
	var storeID int64
	err := database.CommonDB().QueryRow(`SELECT store_id FROM order_stores WHERE order_id=?`, order.ID).Scan(&storeID)
	if err == sql.ErrNoRows || (err == nil && storeID < 1) {
		return false, false
	}
	if err != nil || order.ID < 1 || order.User < 1 {
		return true, false
	}
	if order.ParentOrderId > 0 || (order.PaymentMethod != PaymentMethodCOC && order.PaymentMethod != PaymentMethodPrepaid) {
		return true, false
	}
	raw, ok := database.CommonDB().(*sql.DB)
	if !ok {
		return true, false
	}
	if _, err = poscheckout.HTTPHandlers(os.Getenv, false); err != nil {
		return true, false
	}
	result, err := confirmPOSCheckout(context.Background(), raw, order, newPOSCheckoutRequestID(), nil)
	return true, err == nil && result.UserID == int64(order.User) && result.StoreID == storeID
}

func confirmPOSCheckout(ctx context.Context, database *sql.DB, order *Order, requestID string, operatorID *int64) (poscheckout.Confirmation, error) {
	return poscheckout.Confirm(ctx, database, int64(order.ID), poscheckout.DefaultHashes, func(tx *sql.Tx) error {
		scoped, err := gorm.Open("mysql", tx)
		if err != nil {
			return err
		}
		scoped.LogMode(false)
		var fresh Order
		if err = scoped.Where("id=?", order.ID).First(&fresh).Error; err != nil {
			return err
		}
		if fresh.User != order.User {
			return poscheckout.ErrReview
		}
		if err = fresh.applyPOSCheckoutSource(scoped); err != nil {
			return err
		}
		var lines []HasProduct
		if err = scoped.Where("order_id=?", fresh.ID).Find(&lines).Error; err != nil {
			return err
		}
		enqueue := func(resource string, productID int64) error {
			return poscheckout.EnqueueEffect(ctx, tx, poscheckout.Effect{OrderID: int64(fresh.ID), UserID: int64(fresh.User), OperatorID: operatorID, Resource: resource, Payload: poscheckout.EffectPayload{ProductID: productID}, RequestID: requestID})
		}
		products := map[uint]bool{}
		welcome := false
		for _, line := range lines {
			products[line.Product] = true
			value := strings.TrimSpace(strings.Join([]string{os.Getenv("EXCLUSIVE_PRODUCT_ID"), os.Getenv("EXCLUSIVE_99_PRODUCT_ID"), os.Getenv("EXCLUSIVE_QUARTERLY_ID"), os.Getenv("EXCLUSIVE_QUARTERLY_ID_FREE")}, ","))
			if listContains(strings.Split(value, ","), strconv.FormatUint(uint64(line.Product), 10)) {
				welcome = true
			}
		}
		for productID := range products {
			if err = enqueue("inventory-sync", int64(productID)); err != nil {
				return err
			}
		}
		events := []string{"order-engagement", "gift-voucher-emails", "store-utm", "freebie-count"}
		if fresh.PaymentMethod != PaymentMethodCOC {
			events = append(events, "order-producer", "auto-deliver")
		} else {
			events = append(events, "order-email")
		}
		if fresh.VoucherUsed > 0 {
			events = append(events, "gift-voucher-check")
		}
		if welcome {
			events = append(events, "welcome-exclusive")
		}
		for _, resource := range events {
			if err = enqueue(resource, 0); err != nil {
				return err
			}
		}
		return nil
	})
}
func posCheckoutRejected(c *gin.Context) bool {
	c.JSON(http.StatusServiceUnavailable, gin.H{"status": http.StatusServiceUnavailable, "message": "Order projection requires reconciliation."})
	return true
}
func newPOSCheckoutRequestID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err == nil {
		return hex.EncodeToString(value[:])
	}
	return strconv.FormatInt(time.Now().UnixNano(), 10)
}
