package juspay

import "github.com/jinzhu/gorm"

// Only original payment-failure history sites call these typed mappings. An
// unset Go expiry maps to the native nullable column's DEFAULT NULL; a genuine
// earning expiry is always passed through unchanged. Balances and other fields
// retain the original methods' arithmetic and writes.
func createOriginalFailureMoneyHistory(db *gorm.DB, row *TssMoneyHistory) *gorm.DB {
	if row.Expiry.IsZero() {
		return db.Omit("expiry").Create(row)
	}
	return db.Create(row)
}

func createOriginalFailurePointsHistory(db *gorm.DB, row *TssPointHistory) *gorm.DB {
	if row.Expiry.IsZero() {
		return db.Omit("expiry").Create(row)
	}
	return db.Create(row)
}
