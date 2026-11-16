// Generated from payments 434f3e438d1cb48c64e5723222c6efda506db571. Allocation expressions are source-owned.
package juspay

import (
	"fmt"
	"github.com/jinzhu/gorm"
	"math"
	"os"
	"strings"
	"time"
)

func (o *Order) applyPOSCheckoutSource(Db *gorm.DB) error {
	if o.ID < 1 {
		return errPOSCheckoutReview
	}
	if o.Status > 0 {
		return errPOSCheckoutReview
	}
	var orderStore OrderStore
	if result := Db.Where("order_id= ?", o.ID).First(&orderStore); result.Error != nil {
		return result.Error
	}
	order_status := 1
	if orderStore.StoreID > 0 && o.PaymentMethod != 14 {
		order_status = 3
	}
	paymentMethods := []int{PaymentMethodCard, PaymentMethodNetbank, PaymentMethodWallet, PaymentMethodUPI, PaymentMethodTWID, PaymentMethodSnapmint}
	payment_status := 1
	if o.PaymentStatus == 8 || o.PaymentMethod == 3 || (o.PaymentStatus == 6 && contains(paymentMethods, o.PaymentMethod)) {
		payment_status = 4
	} else {
		payment_status = 1
	}
	if result := Db.Model(&o).Limit(1).Update(map[string]interface {
	}{"order_status": order_status, "payment_status": payment_status, "cashback_used": o.CashbackUsed}); result.Error != nil {
		return result.Error
	}
	if (o.HlParentOrderId <= 0 && os.Getenv("IS_DEDUCT") == "1") || orderStore.StoreID > 0 {
		if o.CashbackUsed > 0 {
			var user User
			if result := Db.Raw("SELECT tss_money FROM users WHERE id = ?", o.User).Scan(&user); result.Error != nil {
				return result.Error
			}
			cashback := user.TssMoney
			if result := Db.Exec("UPDATE users SET cashback=? WHERE id = ?", (user.TssMoney - o.CashbackUsed), o.User); result.Error != nil {
				return result.Error
			}
			rh := RewardPointHistory{UserID: o.User, OrderID: o.ID, AddedAmt: o.CashbackUsed * (-1.0), AmtBefore: cashback, AmtAfter: cashback - o.CashbackUsed, Comment: "Order Placed: Reward Points Deducted", Platform: "ORDER_PLACED", AddedUser: 0}
			if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
				return result.Error
			}
		}
		if o.TssMoneyUsed > 0 {
			var user User
			if result := Db.Raw("SELECT tss_money FROM users WHERE id = ?", o.User).Scan(&user); result.Error != nil {
				return result.Error
			}
			tss_money := user.TssMoney
			if result := Db.Exec("UPDATE users SET tss_money=? WHERE id = ?", (user.TssMoney - o.TssMoneyUsed), o.User); result.Error != nil {
				return result.Error
			}
			rh := TssMoneyHistory{UserID: o.User, OrderID: o.ID, AddedAmt: math.Round(float64(o.TssMoneyUsed*(-1.0)*100)) / 100, AmtBefore: math.Round(float64(tss_money)*100) / 100, AmtAfter: math.Round(float64(tss_money-o.TssMoneyUsed)*100) / 100, Comment: "Order Placed: TSS Money Deducted", Platform: "ORDER_PLACED", AddedUser: 0}
			if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
				return result.Error
			}
			var TssMoneyHistory []TssMoneyHistory
			if result := Db.Raw("SELECT * FROM tss_money_history WHERE is_expired = 0 and added_amt > 0 and user_id = ? order by case when platform = 'FIRST_ORDER_RETURN_BONUS' then 0 else 1 end ASC, created_at ASC", o.User).Scan(&TssMoneyHistory); result.Error != nil {
				return result.Error
			}
			var amount float32
			amount = o.TssMoneyUsed
			if len(TssMoneyHistory) > 0 {
				for _, tms := range TssMoneyHistory {
					var tm_id uint
					var added_amt float32
					var used_amt float32
					var left_over_amt float64
					tm_id = tms.ID
					added_amt = float32(tms.AddedAmt)
					used_amt = float32(tms.UsedAmt)
					left_over_amt = math.Round(float64(added_amt-used_amt)*100) / 100
					if left_over_amt > 0 {
						var sub float64 = math.Round((float64(amount)-left_over_amt)*100) / 100
						var new_used_amt float32
						new_used_amt = 0
						if sub == 0 || sub < 0 {
							new_used_amt = used_amt + amount
							rh := OrderTssMoney{OrderID: o.ID, TssMoneyID: tm_id, UsedAmount: amount}
							if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
								return result.Error
							}
						} else if sub > 0 {
							new_used_amt = used_amt + float32(left_over_amt)
							rh := OrderTssMoney{OrderID: o.ID, TssMoneyID: tm_id, UsedAmount: float32(left_over_amt)}
							if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
								return result.Error
							}
						}
						if new_used_amt > 0 {
							if result := Db.Exec("UPDATE tss_money_history SET used_amt = ? WHERE id = ?", new_used_amt, tm_id); result.Error != nil {
								return result.Error
							}
							amount = float32(sub)
						}
						if sub == 0 || sub < 0 {
							break
						}
					}
				}
			}
		}
		if o.TssPointsUsed > 0 {
			var user User
			if result := Db.Raw("SELECT tss_points FROM users WHERE id = ?", o.User).Scan(&user); result.Error != nil {
				return result.Error
			}
			tss_points := user.TssPoints
			if result := Db.Exec("UPDATE users SET tss_points=? WHERE id = ?", (user.TssPoints - o.TssPointsUsed), o.User); result.Error != nil {
				return result.Error
			}
			rh := TssPointHistory{UserID: o.User, OrderID: o.ID, GameCategoryId: 0, AddedAmt: math.Round(float64(o.TssPointsUsed*(-1.0))*100) / 100, AmtBefore: math.Round(float64(tss_points)*100) / 100, AmtAfter: math.Round(float64(tss_points-o.TssPointsUsed)*100) / 100, Comment: "Order Placed: TSS Points Deducted", Platform: "ORDER_PLACED", AddedUser: 0}
			if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
				return result.Error
			}
			var TssPointsHistory []TssPointHistory
			if result := Db.Raw("SELECT * FROM tss_point_history WHERE is_expired = 0 and added_amt > 0 and user_id = ? order by created_at ASC", o.User).Scan(&TssPointsHistory); result.Error != nil {
				return result.Error
			}
			var points float32
			points = o.TssPointsUsed
			if len(TssPointsHistory) > 0 {
				for _, tms := range TssPointsHistory {
					var tm_id uint
					var added_amt float32
					var used_amt float32
					var left_over_amt float64
					tm_id = tms.ID
					added_amt = float32(tms.AddedAmt)
					used_amt = float32(tms.UsedAmt)
					left_over_amt = math.Round(float64(added_amt-used_amt)*100) / 100
					if left_over_amt > 0 {
						var sub float64 = math.Round((float64(points)-left_over_amt)*100) / 100
						var new_used_amt float32
						new_used_amt = 0
						if sub == 0 || sub < 0 {
							new_used_amt = used_amt + points
							rh := OrderTssPoint{OrderID: o.ID, TssPointID: tm_id, UsedAmount: points}
							if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
								return result.Error
							}
						} else if sub > 0 {
							new_used_amt = used_amt + float32(left_over_amt)
							rh := OrderTssPoint{OrderID: o.ID, TssPointID: tm_id, UsedAmount: float32(left_over_amt)}
							if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
								return result.Error
							}
						}
						if new_used_amt > 0 {
							if result := Db.Exec("UPDATE tss_point_history SET used_amt = ? WHERE id = ?", new_used_amt, tm_id); result.Error != nil {
								return result.Error
							}
							points = float32(sub)
						}
						if sub == 0 || sub < 0 {
							break
						}
					}
				}
			}
		}
		if o.VoucherUsed > 0 {
			var gf GiftVoucher
			if result := Db.Where("id=?", o.VoucherUsed).First(&gf); result.Error != nil {
				return result.Error
			}
			if o.VoucherAmountUsed <= gf.VoucherValue {
				voucherValue := gf.VoucherValue
				newValue := math.Round((gf.VoucherValue-o.VoucherAmountUsed)*100) / 100
				if result := Db.Model(&gf).Limit(1).Update("voucher_value", newValue); result.Error != nil {
					return result.Error
				}
				if gf.GvType == "GIFT_CARD" {
					if result := Db.Model(&gf).Limit(1).Update("status", 0); result.Error != nil {
						return result.Error
					}
				}
				rh := GiftVoucherHistory{UserID: o.User, OrderID: o.ID, GvID: gf.ID, AddedAmt: math.Round(o.VoucherAmountUsed*(-1.0)*100) / 100, AmtBefore: math.Round(voucherValue*100) / 100, AmtAfter: math.Round((voucherValue-o.VoucherAmountUsed)*100) / 100, Comment: "Order Placed: Gift Voucher Deducted", Platform: "ORDER_PLACED", AddedUser: 0}
				if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
					return result.Error
				}
			} else {
				return errPOSCheckoutReview
			}
		}
		if o.CouponUsed > 0 {
			if result := Db.Exec("UPDATE coupons_users SET coupon_used_count= coupon_used_count + 1 WHERE c_id=? and user_id=?", o.CouponUsed, o.User); result.Error != nil {
				return result.Error
			}
			oc := OrderCouponLog{UserID: o.User, OrderID: o.ID, CouponID: o.CouponUsed, Status: 1}
			if result := createPOSCheckoutRecord(Db, &oc); result.Error != nil {
				return result.Error
			}
		}
	}
	if o.HlParentOrderId <= 0 {
		if result := Db.Exec("UPDATE gift_vouchers SET status = CASE WHEN ?=4 AND ?=3 THEN 1 ELSE 0 END WHERE order_id = ?", payment_status, order_status, o.ID); result.Error != nil {
			return result.Error
		}
		if result := Db.Exec("UPDATE referral_log SET order_count = 1, order_id = ? WHERE referred_to = ?", o.ID, o.User); result.Error != nil {
			return result.Error
		}
	}
	var cartItems []HasProduct
	if result := Db.Where("order_id= ?", o.ID).Find(&cartItems); result.Error != nil {
		return result.Error
	}
	var saveTheSoulProductInOrder = false
	var saveTheSoulProductTotalAmt float32
	saveTheSoulProductTotalAmt = 0
	for _, cartItem := range cartItems {
		var prod Product
		if orderStore.StoreID > 0 && o.PaymentMethod != 14 {
			if result := Db.Model(&cartItem).Limit(1).Update("status", "DELIVERED"); result.Error != nil {
				return result.Error
			}
		} else {
			if result := Db.Model(&cartItem).Limit(1).Update("status", "PLACED"); result.Error != nil {
				return result.Error
			}
		}
		if result := Db.Where("id= ?", cartItem.Product).First(&prod); result.Error != nil {
			return result.Error
		}
		if (fmt.Sprint(cartItem.Product) == os.Getenv("EXCLUSIVE_PRODUCT_ID")) || (fmt.Sprint(cartItem.Product) == os.Getenv("EXCLUSIVE_99_PRODUCT_ID")) || (fmt.Sprint(cartItem.Product) == os.Getenv("EXCLUSIVE_QUARTERLY_ID")) || (fmt.Sprint(cartItem.Product) == os.Getenv("EXCLUSIVE_QUARTERLY_ID_FREE")) {
			var user User
			if result := Db.Select("email").Where("id = ?", o.User).Find(&user); result.Error != nil {
				return result.Error
			}
			var userEav UserEAV
			if result := Db.Model(&userEav).Limit(1).Where("entity = ?", user.Email).Where("attribute= ?", "EXCLUSIVE_MEMBER").Update("is_active", 1); result.Error != nil {
				return result.Error
			}
			if result := Db.Model(&userEav).Limit(1).Where("entity = ?", user.Email).Where("attribute= ?", "EXCLUSIVE_EXPIRY").Update("is_active", 1); result.Error != nil {
				return result.Error
			}
		}
		if listContains(strings.Split(os.Getenv("EXCLUSIVE_UPGRADE_IDS"), ","), fmt.Sprint(cartItem.Product)) {
			var exclusiveUpgradeID = fmt.Sprint(cartItem.Product)
			var expiry_delta = getExpiryDelta(exclusiveUpgradeID)
			var user User
			if result := Db.Select("email").Where("id = ?", o.User).Find(&user); result.Error != nil {
				return result.Error
			}
			var userEav UserEAV
			res := Db.Where("entity=?", user.Email).Where("attribute= ?", "EXCLUSIVE_EXPIRY").First(&userEav)
			if res.Error != nil && !gorm.IsRecordNotFoundError(res.Error) {
				return res.Error
			}
			if res.Error == nil {
				var expiryValue = userEav.Value
				expiryValue = strings.Replace(expiryValue, "T", " ", 1)
				currExpiryDate, err := time.Parse("2006-01-02 15:04:05", expiryValue)
				if err != nil {
					return err
				} else {
					var newExpiryDate = currExpiryDate.AddDate(0, 0, expiry_delta).Format("2006-01-02T15:04:05.000000")
					loc, _ := time.LoadLocation("Asia/Kolkata")
					currentTime := time.Now().In(loc)
					var currDate = currentTime.Format("2006-01-02 15:04:05")
					var value = "1"
					switch expiry_delta {
					case 330:
						value = "4"
					case 270:
						value = "5"
					case 365:
						value = "6"
					}
					var userEav1 UserEAV
					var userEav2 UserEAV
					if result := Db.Model(&userEav1).Limit(1).Where("entity = ?", user.Email).Where("attribute= ?", "EXCLUSIVE_MEMBER").Update("value", value); result.Error != nil {
						return result.Error
					}
					if result := Db.Model(&userEav2).Limit(1).Where("entity = ?", user.Email).Where("attribute= ?", "EXCLUSIVE_EXPIRY").Update("value", newExpiryDate).Update("updated_at", currDate); result.Error != nil {
						return result.Error
					}
				}
			} else {
			}
		} else {
		}
		if listContains(strings.Split(os.Getenv("SAVE_THE_SOUL_PRODUCT_ID"), ","), fmt.Sprint(cartItem.Product)) {
			saveTheSoulProductInOrder = true
			saveTheSoulProductTotalAmt = saveTheSoulProductTotalAmt + cartItem.Price
		}
		{
			storeID := orderStore.StoreID
			var productStore ProductStore
			if result := Db.Table("product_store").Where("product_id= ?", cartItem.Product).Where("store_id= ?", storeID).First(&productStore); result.Error != nil {
				return result.Error
			}
			if err := reducePOSCheckoutStock(Db, &productStore, cartItem.Quantity); err != nil {
				return err
			}
		}
	}
	if orderStore.StoreID > 0 && o.PaymentMethod != 14 {
		loc, _ := time.LoadLocation("Asia/Kolkata")
		currentTime := time.Now().In(loc)
		co := Comment{OrderID: o.ID, StatusID: 3, Comment: "Store Order: Delivered status changed by user on order place.", Notify: 1, UserID: o.User, CreatedAt: currentTime.Format("2006-01-02 15:04:05"), UpdatedAt: currentTime.Format("2006-01-02 15:04:05")}
		if result := createPOSCheckoutRecord(Db, &co); result.Error != nil {
			return result.Error
		}
	}
	if saveTheSoulProductInOrder {
		var user User
		if result := Db.Raw("SELECT tss_points FROM users WHERE id = ?", o.User).Scan(&user); result.Error != nil {
			return result.Error
		}
		tss_points := user.TssPoints
		if result := Db.Exec("UPDATE users SET tss_points=? WHERE id = ?", (user.TssPoints + saveTheSoulProductTotalAmt), o.User); result.Error != nil {
			return result.Error
		}
		rh := TssPointHistory{UserID: o.User, OrderID: o.ID, GameCategoryId: 0, AddedAmt: math.Round(float64(saveTheSoulProductTotalAmt)*100) / 100, AmtBefore: math.Round(float64(tss_points)*100) / 100, AmtAfter: math.Round(float64(tss_points+saveTheSoulProductTotalAmt)*100) / 100, Comment: "Order Placed: TSS Points added against donation.", Platform: "DONATION_POINTS_1", AddedUser: 0, Expiry: time.Now().AddDate(0, 1, 0)}
		if result := createPOSCheckoutRecord(Db, &rh); result.Error != nil {
			return result.Error
		}
	}
	return nil
}
