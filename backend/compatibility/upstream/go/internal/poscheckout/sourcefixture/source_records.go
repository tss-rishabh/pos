package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"github.com/jinzhu/gorm"
)

var errPOSCheckoutReview = poscheckout.ErrReview

func reducePOSCheckoutStock(db *gorm.DB, stock *ProductStore, quantity int) error {
	return poscheckout.ReduceStoreStock(db.CommonDB(), int64(stock.ID), int64(stock.StoreID), int64(stock.ProductID), int64(quantity))
}

// A debit has no earning expiry. Both physical legacy columns are nullable;
// omit only an unset expiry on negative debit history rows instead of writing
// the source Go zero date, which strict MySQL8 correctly rejects. Allocation
// arithmetic, FIFO ordering and positive earning/donation expiries are retained.
func createPOSCheckoutRecord(db *gorm.DB, value interface{}) *gorm.DB {
	switch row := value.(type) {
	case *TssMoneyHistory:
		if row.AddedAmt < 0 && row.Expiry.IsZero() {
			return db.Omit("expiry").Create(value)
		}
	case *TssPointHistory:
		if row.AddedAmt < 0 && row.Expiry.IsZero() {
			return db.Omit("expiry").Create(value)
		}
	}
	return db.Create(value)
}
