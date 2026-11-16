package poscheckout

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type EffectPayload struct {
	ProductID int64 `json:"productId,omitempty"`
}
type Effect struct {
	ID              string
	OrderID, UserID int64
	OperatorID      *int64
	Resource        string
	Payload         EffectPayload
	RequestID       string
}
type Handler func(context.Context, Effect) error
type Outcome struct {
	Effect Effect
	Status string
}
type Rejected struct{}

func (Rejected) Error() string { return "delivery rejected" }

var resources = map[string]bool{"inventory-sync": true, "welcome-exclusive": true, "order-producer": true, "order-engagement": true, "gift-voucher-check": true, "auto-deliver": true, "order-email": true, "gift-voucher-emails": true, "store-utm": true, "freebie-count": true}

func EnqueueEffect(ctx context.Context, tx *sql.Tx, effect Effect) error {
	if effect.OrderID < 1 || effect.UserID < 1 || !resources[effect.Resource] || effect.Payload.ProductID < 0 || len(effect.RequestID) > 128 {
		return ErrReview
	}
	effect.ID = fmt.Sprintf("checkout:%d:%s:%d", effect.OrderID, effect.Resource, effect.Payload.ProductID)
	payload, err := json.Marshal(effect.Payload)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO pos_rewrite_checkout_projection_effects(id,order_id,user_id,operator_id,resource,payload,status,request_id,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON DUPLICATE KEY UPDATE id=id`, effect.ID, effect.OrderID, effect.UserID, effect.OperatorID, effect.Resource, payload, effect.RequestID)
	return err
}

// Dispatch never recovers a processing/uncertain job automatically. A crashed
// worker may already have sent it. Missing configured handlers leave jobs
// pending rather than manufacturing a delivery outcome.
func Dispatch(ctx context.Context, db *sql.DB, handlers map[string]Handler, limit int, observe func(Outcome)) error {
	if limit < 1 || limit > 100 {
		return ErrReview
	}
	var names []string
	for name, handler := range handlers {
		if !resources[name] || handler == nil {
			return ErrReview
		}
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		return nil
	}
	for index := 0; index < limit; index++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		args := make([]interface{}, len(names))
		for index, name := range names {
			args[index] = name
		}
		query := `SELECT id,order_id,user_id,operator_id,resource,payload,COALESCE(request_id,'') FROM pos_rewrite_checkout_projection_effects WHERE status='pending' AND resource IN (` + strings.TrimSuffix(strings.Repeat("?,", len(names)), ",") + `) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`
		var effect Effect
		var payload []byte
		var operator sql.NullInt64
		err = tx.QueryRowContext(ctx, query, args...).Scan(&effect.ID, &effect.OrderID, &effect.UserID, &operator, &effect.Resource, &payload, &effect.RequestID)
		if operator.Valid {
			effect.OperatorID = &operator.Int64
		}
		if errors.Is(err, sql.ErrNoRows) {
			tx.Rollback()
			return nil
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE pos_rewrite_checkout_projection_effects SET status='processing',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`, effect.ID); err != nil {
			tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		status := "uncertain"
		if err = json.Unmarshal(payload, &effect.Payload); err == nil && effect.OrderID > 0 && effect.UserID > 0 && effect.Payload.ProductID >= 0 {
			err = deliverSafely(ctx, handlers[effect.Resource], effect)
			if err == nil {
				status = "delivered"
			} else {
				var rejected Rejected
				if errors.As(err, &rejected) {
					status = "rejected"
				}
			}
		} else {
			status = "rejected"
		}
		if _, err = db.ExecContext(ctx, `UPDATE pos_rewrite_checkout_projection_effects SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'`, status, effect.ID); err != nil {
			return err
		}
		if observe != nil {
			observe(Outcome{Effect: effect, Status: status})
		}
	}
	return nil
}
func deliverSafely(ctx context.Context, handler Handler, effect Effect) (err error) {
	defer func() {
		if recover() != nil {
			err = ErrReview
		}
	}()
	return handler(ctx, effect)
}
