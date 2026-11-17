package poscheckout

import (
	"context"
	"database/sql"
)

// This is a journal observation, never permission to dispatch an effect again.
// Provider/body data and private delivery responses are deliberately omitted.
type OriginEffectStatus struct {
	ID           string  `json:"id"`
	Kind         string  `json:"kind"`
	Sequence     int64   `json:"sequence"`
	Priority     int64   `json:"priority"`
	Phase        string  `json:"phase"`
	UpdatedAt    int64   `json:"updatedAt"`
	EvidenceHash *string `json:"evidenceHash,omitempty"`
}
type OriginEffectStatusView struct {
	Contract        string               `json:"contract"`
	CommandID       string               `json:"commandId"`
	OrderID         string               `json:"orderId"`
	Status          string               `json:"status"`
	DispatchBlocked bool                 `json:"dispatchBlocked"`
	Effects         []OriginEffectStatus `json:"effects"`
}

// Effects authenticates current read authority for the original scope. It does
// not contact a provider/recipient, acquire a writer lease or alter a phase.
func (e *OriginEngine) Effects(ctx context.Context, cap OriginPaymentAuthorization, caller OriginCaller) (OriginEffectStatusView, error) {
	v := OriginEffectStatusView{Contract: "pos-screening-origin-go-effect-status-v1", CommandID: cap.CommandID, OrderID: cap.OrderID, Status: "EMPTY", Effects: []OriginEffectStatus{}}
	if caller.StageRecovery != "" {
		return v, ErrReview
	}
	u, err := e.open(ctx, cap, caller, false, true)
	if err != nil {
		return v, err
	}
	defer u.close()
	// Retain the payment's immutable binding and verify its confirmation receipt
	// before disclosing delivery state. A missing attempt is an honest 404.
	a, payload, response, err := originReadAttempt(ctx, u.tx, cap.CommandID, e.Key)
	if err != nil {
		return v, err
	}
	if a.PaymentRequestHash != cap.PaymentRequestHash {
		return v, ErrReview
	}
	if _, err = e.view(ctx, u, a, payload, response); err != nil {
		return v, err
	}
	rows, err := u.tx.QueryContext(ctx, `SELECT id,command_id,CAST(order_id AS CHAR),kind,priority,sequence_no,phase,CASE WHEN OCTET_LENGTH(data)<=16000 THEN data ELSE NULL END,proof_hash,CASE WHEN OCTET_LENGTH(receipt)<=1400000 THEN receipt ELSE NULL END,receipt_hash,updated_at_ms FROM pos_rewrite_screening_origin_go_effects WHERE command_id=? ORDER BY priority,sequence_no,id LIMIT 1001 FOR SHARE`, cap.CommandID)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var s OriginEffectStatus
		var command, order, seal string
		var raw []byte
		var receiptRaw []byte
		var receiptHash sql.NullString
		if rows.Scan(&s.ID, &command, &order, &s.Kind, &s.Priority, &s.Sequence, &s.Phase, &raw, &seal, &receiptRaw, &receiptHash, &s.UpdatedAt) != nil {
			rows.Close()
			return v, ErrReview
		}
		var effect OriginEffect
		if len(v.Effects) >= 1000 || originVerify(e.Key, "go-effect", raw, seal, &effect, 16000) != nil || effect.ID != s.ID || !originHash.MatchString(s.ID) || effect.CommandID != cap.CommandID || command != cap.CommandID || effect.OrderID != cap.OrderID || order != cap.OrderID || effect.CustomerID != cap.CustomerID || !originSame(effect.ActorID, u.command.ActorID) || effect.Kind != s.Kind || !originEffectKinds[s.Kind] || effect.Sequence != s.Sequence || s.Sequence < 1 || effect.Priority != s.Priority || s.Priority != originEffectPriority(s.Kind) || !originPoint(s.UpdatedAt) {
			rows.Close()
			return v, ErrReview
		}
		switch s.Phase {
		case "PENDING", "SENDING", "UNCERTAIN", "ACCEPTED":
		default:
			rows.Close()
			return v, ErrReview
		}
		if receiptHash.Valid {
			var receipt OriginEffectReceipt
			// Receipt MAC wraps the effect id, so a valid receipt cannot migrate to a
			// different effect. Decode with the same strict bounds as the dispatcher.
			if OriginDecode(receiptRaw, &receipt, 1400000) != nil || !originHash.MatchString(receipt.EvidenceHash) || len(receipt.Additional) > 1000 {
				rows.Close()
				return v, ErrReview
			}
			hash, err := OriginMAC(e.Key, "go-effect-receipt", map[string]interface{}{"effectId": s.ID, "receipt": receipt})
			if err != nil || !OriginHashEqual(hash, receiptHash.String) || s.Phase == "ACCEPTED" && !receipt.Accepted {
				rows.Close()
				return v, ErrReview
			}
			s.EvidenceHash = &receipt.EvidenceHash
		} else if len(receiptRaw) > 0 || s.Phase == "ACCEPTED" {
			rows.Close()
			return v, ErrReview
		}
		if s.Phase == "SENDING" || s.Phase == "UNCERTAIN" {
			v.DispatchBlocked = true
		}
		v.Effects = append(v.Effects, s)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	if len(v.Effects) > 0 {
		v.Status = "ACCEPTED"
		for _, s := range v.Effects {
			if s.Phase != "ACCEPTED" {
				v.Status = "PENDING"
			}
		}
		if v.DispatchBlocked {
			v.Status = "UNCERTAIN"
		}
	}
	return v, u.commit(ctx)
}
