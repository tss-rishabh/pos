package juspay

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"

	"backend-tss-domestic_payments_api/internal/posstock"
	"backend-tss-domestic_payments_api/utils"
	"github.com/gin-gonic/gin"
	"github.com/parnurzeal/gorequest"
)

// tryConfirmPOSExchange is called before ProcessOrder's asynchronous legacy
// branches. true means this request was handled, including a safe rejection.
func tryConfirmPOSExchange(c *gin.Context, order *Order) bool {
	if order.ParentOrderId < 1 || order.PaymentMethod != PaymentMethodPrepaid {
		return false
	}
	database := utils.Db.DB()
	var storeID int64
	err := database.QueryRowContext(c.Request.Context(), `SELECT store_id FROM order_stores WHERE order_id=?`, order.ID).Scan(&storeID)
	if err == sql.ErrNoRows {
		return false
	}
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": http.StatusServiceUnavailable, "message": "Order confirmation requires review."})
		return true
	}
	if storeID < 1 {
		return false
	}
	confirmation, err := posstock.Confirm(c.Request.Context(), database, int64(order.ID))
	if err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": http.StatusServiceUnavailable, "message": "Order confirmation requires review."})
		return true
	}
	if confirmation.Created {
		requestID := c.GetHeader("X-Request-ID")
		if !regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`).MatchString(requestID) {
			requestID = posCompatibilityID()
		}
		// These source side effects run after the durable transaction, once for
		// a newly committed child. A proof replay never repeats them. Their
		// success is independent of the stock proof; unknown sends are logged
		// with identifiers only and are not automatically retried.
		go func() {
			resp, _, errs := gorequest.New().Get(fmt.Sprintf("%s%d", os.Getenv("POS_PRODUCT_SYNC"), confirmation.ProductID)).End()
			posCompatibilityOutcome("pos-exchange-inventory-sync", requestID, order, resp, errs)
		}()
		go func() {
			resp, _, errs := gorequest.New().Post(os.Getenv("ORDER_PRODUCER_URL")).Set("ar-app-id", os.Getenv("POST_ORDER_APP_ID")).Set("ar-app-key", os.Getenv("POST_ORDER_APP_KEY")).Send(map[string]int{"payload": order.ID}).End()
			posCompatibilityOutcome("pos-exchange-order-producer", requestID, order, resp, errs)
		}()
		go func() {
			resp, _, errs := gorequest.New().Post(os.Getenv("ORDER_EMAIL")).Send(map[string]int{"orderId": order.ID}).End()
			posCompatibilityOutcome("pos-exchange-order-email", requestID, order, resp, errs)
		}()
	}
	// Preserve the original success status and response body exactly.
	c.JSON(http.StatusCreated, gin.H{"status": http.StatusCreated, "message": "/thank-you"})
	return true
}

func posCompatibilityID() string {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return makeEventId("pos-exchange")
	}
	return hex.EncodeToString(value[:])
}
func posCompatibilityOutcome(resource, requestID string, order *Order, response *http.Response, errors []error) {
	action := "delivered"
	if len(errors) > 0 || response == nil {
		action = "uncertain"
	} else if response.StatusCode >= 400 {
		action = "rejected"
	}
	value := struct {
		EventID         string `json:"eventId"`
		EventInstanceID string `json:"eventInstanceId"`
		Module          string `json:"module"`
		Resource        string `json:"resource"`
		RequestID       string `json:"requestId"`
		UserID          int    `json:"userId"`
		OrderID         int    `json:"orderId"`
	}{"payments." + resource + "." + action, posCompatibilityID(), "payments", resource, requestID, order.User, order.ID}
	encoded, err := json.Marshal(value)
	if err == nil {
		utils.Infof("%s", string(encoded))
	}
}
