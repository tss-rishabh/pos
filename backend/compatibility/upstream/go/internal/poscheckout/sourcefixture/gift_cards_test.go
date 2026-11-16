package sourcefixture

import (
	"backend-tss-domestic_payments_api/internal/poscheckout"
	"context"
	"database/sql"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func seedPhysicalCard(t *testing.T, db *sql.DB, orderID int) {
	t.Helper()
	execute(t, db, `INSERT INTO gift_card_collection(id,size,is_completed,is_block,is_printed) VALUES(1,10,1,0,1)`)
	execute(t, db, `INSERT INTO gift_vouchers(id,order_id,from_id,collection_no,gift_card_srno,voucher_code,gv_type,voucher_value,voucher_initial_value,status,start_date,end_date) VALUES(9001,?,77,1,990111,'GC-CONTROLLED','GIFT_CARD',10,10,0,'2026-11-16','2027-02-14')`, orderID)
}

func TestGiftCardCollectionFenceBeforeAllocations(t *testing.T) {
	for _, flags := range []string{"is_block=1", "is_block=2", "is_printed=0", "is_completed=0", "size=0"} {
		t.Run(flags, func(t *testing.T) {
			db := fixture(t)
			seedWalletCredit(t, db)
			seedOrder(t, db, 9001, 3, 10, 0)
			seedPhysicalCard(t, db, 9001)
			execute(t, db, `UPDATE gift_card_collection SET `+flags+` WHERE id=1`)
			calls := 0
			_, err := poscheckout.Confirm(context.Background(), db, 9001, poscheckout.DefaultHashes, func(tx *sql.Tx) error {
				calls++
				return sourceApply(tx, 9001, false)
			})
			if err == nil || calls != 0 || number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 100 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
				t.Fatal("unavailable physical card reached financial allocations")
			}
		})
	}
}

func TestGiftCardPrepaidProofAndTwentyReplays(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 9001, 3, 10, 0)
	seedPhysicalCard(t, db, 9001)
	var created atomic.Int32
	var group sync.WaitGroup
	for index := 0; index < 20; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			result, err := confirm(db, 9001)
			if err != nil {
				t.Error(err)
			} else if result.Created {
				created.Add(1)
			}
		}()
	}
	group.Wait()
	if created.Load() != 1 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_gift_card_issuances`) != 1 || number(t, db, `SELECT status FROM gift_vouchers WHERE id=9001`) != 1 || number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 90 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 {
		t.Fatal("physical card funding was not committed exactly once")
	}
	execute(t, db, `UPDATE gift_card_collection SET is_block=1 WHERE id=1`)
	execute(t, db, `UPDATE gift_vouchers SET status=0,voucher_value=0 WHERE id=9001`)
	if result, err := confirm(db, 9001); err != nil || result.Created {
		t.Fatal("later block/redemption erased the original funding proof", err)
	}
	execute(t, db, `UPDATE gift_vouchers SET voucher_initial_value=11 WHERE id=9001`)
	if _, err := confirm(db, 9001); err == nil {
		t.Fatal("tampered immutable gift value reused a funding proof")
	}
}

func TestGiftCardNormalConfirmationLeavesFundingPending(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 9001, 14, 0, 0)
	seedPhysicalCard(t, db, 9001)
	if _, err := confirm(db, 9001); err != nil {
		t.Fatal(err)
	}
	if number(t, db, `SELECT status FROM gift_vouchers WHERE id=9001`) != 0 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_gift_card_issuances`) != 0 {
		t.Fatal("unpaid physical card was funded")
	}
	execute(t, db, `UPDATE gift_card_collection SET is_block=1 WHERE id=1`)
	if _, err := confirm(db, 9001); err == nil {
		t.Fatal("pending replay ignored a new batch block")
	}
	if number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 18 {
		t.Fatal("pending replay repeated the stock mutation")
	}
}

func TestGiftCardProofFailureRollsBackWalletStockAndActivation(t *testing.T) {
	db := fixture(t)
	seedWalletCredit(t, db)
	seedOrder(t, db, 9001, 3, 10, 0)
	seedPhysicalCard(t, db, 9001)
	execute(t, db, `CREATE TRIGGER reject_gift_issuance BEFORE INSERT ON pos_rewrite_gift_card_issuances FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='controlled proof failure'`)
	if _, err := confirm(db, 9001); err == nil {
		t.Fatal("late proof failure was swallowed")
	}
	if number(t, db, `SELECT tss_money FROM users WHERE id=77`) != 100 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 || number(t, db, `SELECT status FROM gift_vouchers WHERE id=9001`) != 0 || number(t, db, `SELECT COUNT(*) FROM pos_rewrite_checkout_projections`) != 0 {
		t.Fatal("late physical card proof failure leaked financial writes")
	}
	execute(t, db, `DROP TRIGGER reject_gift_issuance`)
	if result, err := confirm(db, 9001); err != nil || !result.Created {
		t.Fatal("repaired exact operation did not complete once", err)
	}
}

func TestGiftCardBlockAndConfirmationShareTheCollectionLock(t *testing.T) {
	db := fixture(t)
	seedOrder(t, db, 9001, 3, 0, 0)
	seedPhysicalCard(t, db, 9001)
	block, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer block.Rollback()
	if _, err = block.Exec(`UPDATE gift_card_collection SET is_block=1 WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, confirmationErr := confirm(db, 9001)
		result <- confirmationErr
	}()
	select {
	case confirmationErr := <-result:
		t.Fatal("confirmation bypassed the uncommitted batch lock", confirmationErr)
	case <-time.After(100 * time.Millisecond):
	}
	if err = block.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case confirmationErr := <-result:
		if confirmationErr == nil {
			t.Fatal("confirmed after the batch block committed")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("gift confirmation did not release its transaction")
	}
	if number(t, db, `SELECT COUNT(*) FROM pos_rewrite_gift_card_issuances`) != 0 || number(t, db, `SELECT stock FROM product_store WHERE id=1`) != 20 {
		t.Fatal("blocked confirmation leaked stock/funding")
	}
}
