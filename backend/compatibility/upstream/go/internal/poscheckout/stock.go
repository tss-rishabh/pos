package poscheckout

import "database/sql"

type Executor interface {
	Exec(string, ...interface{}) (sql.Result, error)
}

// ReduceStoreStock runs on the caller's already locked transaction. The exact
// integer decrement is retained; a missing row, shortage or SQL failure cannot
// silently publish a successful order.
func ReduceStoreStock(db Executor, id, storeID, productID, quantity int64) error {
	if id < 1 || storeID < 1 || productID < 1 || quantity < 1 {
		return ErrReview
	}
	result, err := db.Exec(`UPDATE product_store SET stock=stock-? WHERE id=? AND store_id=? AND product_id=? AND stock>=? AND is_avail=1 AND is_del=0`, quantity, id, storeID, productID, quantity)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return ErrReview
	}
	return nil
}
