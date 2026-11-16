// Package sourcefixture is isolated source-extraction evidence. It imports no
// upstream application initialization, real database configuration or services.
package sourcefixture

import (
	"database/sql"
	"github.com/jinzhu/gorm"
	_ "github.com/jinzhu/gorm/dialects/mysql"
)

var fixtureAdapterDB *gorm.DB

func sourceApply(tx *sql.Tx, orderID int, oracle bool) error {
	db, err := gorm.Open("mysql", tx)
	if err != nil {
		return err
	}
	db.LogMode(false)
	var order Order
	if err = db.Where("id=?", orderID).First(&order).Error; err != nil {
		return err
	}
	if oracle {
		return order.applyPOSCheckoutOracle(db)
	}
	return order.applyPOSCheckoutSource(db)
}
