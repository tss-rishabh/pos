// Generated from payments 434f3e438d1cb48c64e5723222c6efda506db571. Allocation expressions are source-owned.
package sourcefixture

import (
	"fmt"
	"github.com/jinzhu/gorm"
	"math"
	"os"
	"strings"
	"time"
)

const (
	PaymentMethodCOD      = 1
	PaymentMethodPrepaid  = 3
	PaymentMethodCard     = 10
	PaymentMethodNetbank  = 11
	PaymentMethodWallet   = 12
	PaymentMethodUPI      = 13
	PaymentMethodCOC      = 14
	PaymentMethodTWID     = 17
	PaymentMethodSnapmint = 18
)

type User struct {
	Id        int
	Email     string
	Telephone string `gorm:"default:'1111111111'"`
	Firstname string
	Lastname  string
	Birthdate string
	Gender    string
	Cashback  float32
	TssMoney  float32
	TssPoints float32
}
type Order struct {
	ID                  int       `gorm:"column:id;primary_key;AUTO_INCREMENT"`
	User                int       `gorm:"column:user_id;type:bigint(20)"`
	OrderAmount         float32   `gorm:"column:order_amt;type:double"`
	PayAmount           float32   `gorm:"column:pay_amt;type:double"`
	CodCharges          int       `gorm:"column:cod_charges;type:int(20)"`
	HlCharges           int       `gorm:"column:hl_charges;type:int(20)"`
	GiftingCharges      int       `gorm:"column:gifting_charges;type:int(20)"`
	PaymentMethod       int       `gorm:"column:payment_method;type:int(11)"`
	PaymentStatus       int       `gorm:"column:payment_status;type:int(11)"`
	PaymentID           int       `gorm:"column:payment_id;type:int(11)"`
	TransactionID       string    `gorm:"column:transaction_id;type:varchar(255)"`
	TransactionStatus   string    `gorm:"column:transaction_status;type:text"`
	Description         string    `gorm:"column:description;type:text"`
	Cart                string    `gorm:"column:cart;type:text"`
	CashbackUsed        float32   `gorm:"column:cashback_used;type:float"`
	CashbackEarned      float32   `gorm:"column:cashback_earned;type:float"`
	CashbackCredited    int       `gorm:"column:cashback_credited;type:int(11)"`
	VoucherUsed         int       `gorm:"column:voucher_used;type:bigint(20)"`
	VoucherAmountUsed   float64   `gorm:"column:voucher_amt_used;type:double"`
	CouponUsed          int       `gorm:"column:coupon_used;type:bigint(20)"`
	CouponAmountUsed    float32   `gorm:"column:coupon_amt_used;type:double"`
	ShippingAmount      int       `gorm:"column:shipping_amt;type:int(11)"`
	ShiplabelTrackingID string    `gorm:"column:shiplabel_tracking_id;type:varchar(255)"`
	ReferralCodeUsed    string    `gorm:"column:referal_code_used;type:varchar(255)"`
	ReferralCodeAmount  float32   `gorm:"column:referal_code_amt;type:float"`
	Status              int       `gorm:"column:order_status;type:int(20)"`
	ShipDate            time.Time `gorm:"column:ship_date;type:datetime"`
	ShipFlag            string    `gorm:"column:ship_flag;type:enum('0','1')"`
	OrderComment        string    `gorm:"column:order_comment;type:varchar(255)"`
	FirstName           string    `gorm:"column:first_name;type:varchar(255)"`
	LastName            string    `gorm:"column:last_name;type:varchar(255)"`
	Address1            string    `gorm:"column:address1;type:varchar(35)"`
	Address2            string    `gorm:"column:address2;type:varchar(35)"`
	Address3            string    `gorm:"column:address3;type:varchar(35)"`
	Phone               string    `gorm:"column:phone_no;type:varchar(20)"`
	CountryID           string    `gorm:"column:country_id;type:text"`
	ZoneID              string    `gorm:"column:zone_id;type:text"`
	PostalCode          string    `gorm:"column:postal_code;type:varchar(20)"`
	City                string    `gorm:"column:city;type:varchar(255)"`
	PrintInvoice        int       `gorm:"column:print_invoice;type:int(11)"`
	RefFlag             int       `gorm:"column:ref_flag;type:int(11)"`
	UserRefPoints       float32   `gorm:"column:user_ref_points;type:double"`
	CartRecNotify1      int       `gorm:"column:cart_rec_notify1;type:int(11)"`
	CartRecNotify2      int       `gorm:"column:cart_rec_notify2;type:int(11)"`
	IncompleteOrder     int       `gorm:"column:incomplete_order;type:int(11)"`
	FlagID              int       `gorm:"column:flag_id;type:bigint(20)"`
	FlagComment         string    `gorm:"column:flag_comment;type:text"`
	Courier             int       `gorm:"column:courier;type:int(11)"`
	CourierServiceName  string    `gorm:"column:courier_service_name;type:varchar(255)"`
	WaybillImg          string    `gorm:"column:waybill_img;type:text"`
	WaybillData         string    `gorm:"column:waybill_data;type:text"`
	InternAdded         int       `gorm:"column:intern_added;type:int(11)"`
	InternAmount        float32   `gorm:"column:intern_amt;type:decimal(10,2)"`
	RetExRequestDate    time.Time `gorm:"column:ret_ex_request_date;type:datetime"`
	IsStockReduced      int       `gorm:"column:is_stock_reduced;type:tinyint(4)"`
	CreatedAt           time.Time `gorm:"column:created_at;type:datetime"`
	UpdatedAt           time.Time `gorm:"column:updated_at;type:datetime"`
	TssMoneyUsed        float32   `gorm:"column:tss_money_used;type:float"`
	TssPointsUsed       float32   `gorm:"column:tss_points_used;type:float"`
	TssPointsEarned     float32   `gorm:"column:tss_points_earned;type:float"`
	TssPointsCredited   int       `gorm:"column:tss_points_credited;type:int(11)"`
	OriginalOrderId     int       `gorm:"column:original_order_id;type:bigint(20)"`
	HlParentOrderId     int       `gorm:"column:hl_parent_order_id;type:bigint(20)"`
	ParentOrderId       int       `gorm:"column:parent_order_id;type:bigint(20)"`
	ExchangeCount       int       `gorm:"column:exchange_count;type:int(11)"`
	LocationID          int       `gorm:"column:location_id;type:int(11)"`
	LocationType        string    `gorm:"column:location_type;type:varchar(20)"`
	IsNewCalc           int       `gorm:"column:is_new_calculation;type:int(11)"`
	IsSplitOrder        int       `gorm:"column:is_split_order;type:int(11)"`
	UpiPackageName      string    `gorm:"column:upi_package_name;type:varchar(100)"`
	IsExpress           int       `gorm:"column:is_express;type:int(11)"`
}
type HasProduct struct {
	Id                 uint      `gorm:"column:id;type:bigint(20)"`
	Order              uint      `gorm:"column:order_id;type:bigint(20)"`
	Product            uint      `gorm:"column:prod_id;type:bigint(20)"`
	SubProduct         uint      `gorm:"column:sub_prod_id;type:bigint(20)"`
	Quantity           int       `gorm:"column:qty;type:bigint(20)"`
	Price              float32   `gorm:"column:price;type:double"`
	AmountToBeRefunded float64   `gorm:"column:amount_to_be_refunded;type:float"`
	Status             string    `gorm:"column:status;type:enum('INCOMPLETE','PLACED','PROCESSING','SHIPPED','PARTIALLY_SHIPPED','IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','PARTIALLY_DELIVERED','DELIVERY_EXCEPTION','RTO_INITIATED','RTO_IN_TRANSIT','RTO_DELIVERED','UNDELIVERED','CANCELLED','RETURN_PLACED','SELF_RETURN_PLACED','RETURN_PICKED','RETURN_CANCELLED','RETURN_DELIVERED','SELF_RETURN_DELIVERED','LOST','FAILED','REFUND_COMPLETED')"`
	Discount           float32   `gorm:"column:disc;type:float"`
	DiscountQuantity   int       `gorm:"column:disc_qty;type:bigint(20)"`
	WalletDiscount     float32   `gorm:"column:wallet_disc;type:float"`
	VoucherDiscount    float32   `gorm:"column:voucher_disc;type:float"`
	ReferralDiscount   float32   `gorm:"column:referal_disc;type:float"`
	GST                float32   `gorm:"column:gst;type:float"`
	TSSPointsUsed      float32   `gorm:"column:hp_tss_points_used;type:float"`
	OrderPlatform      int       `gorm:"column:order_platform_id;type:int(11)"`
	CreatedAt          time.Time `gorm:"column:created_at;type:datetime"`
	UpdatedAt          time.Time `gorm:"column:updated_at;type:datetime"`
}
type OrderStore struct {
	ID             uint   `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	OrderID        int    `gorm:"column:order_id;type:bigint(20)"`
	StoreID        int    `gorm:"column:store_id;type:bigint(20)"`
	TransactionID  string `gorm:"column:transaction_id;type:text"`
	IsManuallyPaid int    `gorm:"column:is_manually_paid;type:int(4)"`
}
type ProductStore struct {
	ID        uint `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	ProductID int  `gorm:"column:product_id;type:bigint(20)"`
	Stock     int  `gorm:"column:stock;type:bigint(20)"`
	StoreID   int  `gorm:"column:store_id;type:bigint(20)"`
	IsAvail   int  `gorm:"column:is_avail;type:int(4)"`
	IsDel     int  `gorm:"column:is_del;type:int(4)"`
}
type Comment struct {
	ID            uint   `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	OrderID       int    `gorm:"column:order_id;type:bigint(20)"`
	StatusID      int    `gorm:"column:status_id;type:bigint(20)"`
	Comment       string `gorm:"column:comment;type:text"`
	Notify        int    `gorm:"column:notify;type:int(4)"`
	UserID        int    `gorm:"column:user_id;type:bigint(20)"`
	PackageDetail string `gorm:"column:package_details;type:text"`
	CreatedAt     string `gorm:"column:created_at;type:timestamp"`
	UpdatedAt     string `gorm:"column:updated_at;type:timestamp"`
}
type Product struct {
	ID              uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	Product         string    `gorm:"column:product;type:varchar(255)"`
	Desc            string    `gorm:"column:short_desc;type:text"`
	lDesc           string    `gorm:"column:long_desc;type:text"`
	AddDesc         string    `gorm:"column:add_desc;type:text"`
	AddDescID       int       `gorm:"column:add_desc_id;type:int(11)"`
	Measurement     string    `gorm:"column:measurement;type:varchar(250)"`
	Images          string    `gorm:"column:images;type:text"`
	Prod_type       int       `gorm:"column:prod_type;type:bigint(20)"`
	Attr_set        int       `gorm:"column:attr_set;type:bigint(20)"`
	UrlKey          string    `gorm:"column:url_key;type:varchar(255)"`
	IsAvail         int       `gorm:"column:is_avail;type:tinyint(1)"`
	IsListing       int       `gorm:"column:is_listing;type:tinyint(4)"`
	Processing      int       `gorm:"column:processing;type:bigint(20)"`
	Price           float32   `gorm:"column:price;type:decimal(8,2)"`
	SplPrice        float32   `gorm:"column:spl_price;type:decimal(8,2)"`
	IsCrowdFunded   int       `gorm:"column:is_crowd_funded;type:tinyint(1)"`
	TargetDate      time.Time `gorm:"column:target_date;type:datetime"`
	TargetQty       int       `gorm:"column:target_qty;type:bigint(20)"`
	ParentProductID int       `gorm:"column:parent_prod_id;type:bigint(20)"`
	MetaTitle       string    `gorm:"column:meta_title;type:varchar(100)"`
	MetaKeys        string    `gorm:"column:meta_keys;type:text"`
	MetaDesc        string    `gorm:"column:meta_desc;type:text"`
	ArtCut          float32   `gorm:"column:art_cut;type:float"`
	IsCOD           int       `gorm:"column:is_cod;type:tinyint(1)"`
	AddedBy         int       `gorm:"column:added_by;type:bigint(20)"`
	UpdatedBy       int       `gorm:"column:updated_by;type:bigint(20)"`
	IsIndividual    int       `gorm:"column:is_individual;type:tinyint(1)"`
	IsNotification  int       `gorm:"column:is_notification;type:int(20)"`
	SortOrder       int       `gorm:"column:sort_order;type:bigint(20)"`
	SearchSort      int       `gorm:"column:search_sort;type:int(11)"`
	WWESort         int       `gorm:"column:wwe_sort;type:int(11)"`
	WWEProductSort  int       `gorm:"column:wwe_prod_sort;type:int(11)"`
	OfficialSort    int       `gorm:"column:official_merch_sort_order;type:bigint(20)"`
	IsInternational int       `gorm:"column:is_shipped_international;type:int(11)"`
	IsReferralDisc  int       `gorm:"column:is_referal_discount;type:int(11)"`
	WarehouseCode   string    `gorm:"column:warehouse_code;type:varchar(50)"`
	IsDel           int       `gorm:"column:is_del;type:int(11)"`
	IsJIT           int       `gorm:"column:is_jit;type:int(11)"`
	CreatedAt       time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt       time.Time `gorm:"column:updated_at;type:timestamp"`
}
type GiftVoucher struct {
	ID                  uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	FromID              string    `gorm:"column:from_id;type:bigint(20)"`
	ToEmailID           string    `gorm:"column:to_id;type:varchar(255)"`
	VoucherCode         string    `gorm:"column:voucher_code;type:varchar(25)"`
	Theme               int       `gorm:"column:theme;type:int(11)"`
	ToName              string    `gorm:"column:to_name;type:varchar(100)"`
	ToPhone             int       `gorm:"column:to_phone;type:bigint(20)"`
	VoucherValue        float64   `gorm:"column:voucher_value;type:double"`
	VoucherInitialValue float64   `gorm:"column:voucher_initial_value;type:double"`
	Message             string    `gorm:"column:message;type:text"`
	Status              int       `gorm:"column:status;type:tinyint(4)"`
	OrderId             string    `gorm:"column:order_id;type:bigint(20)"`
	GvType              string    `gorm:"column:gv_type;type:varchar(25)"`
	CouponID            int       `gorm:"column:coupon_id;type:bigint(20)"`
	CreatedAt           time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt           time.Time `gorm:"column:updated_at;type:timestamp"`
}
type RewardPointHistory struct {
	ID        uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	UserID    int       `gorm:"column:user_id;type:bigint(20)"`
	OrderID   int       `gorm:"column:order_id;type:bigint(20)"`
	AddedAmt  float32   `gorm:"column:added_amt;type:double"`
	AmtBefore float32   `gorm:"column:amt_before_update;type:double"`
	AmtAfter  float32   `gorm:"column:amt_after_update;type:double"`
	Comment   string    `gorm:"column:comment;type:text"`
	Platform  string    `gorm:"column:platform;type:enum('ORDER_PLACED, ORDER_CANCELLED, ORDER_REFUND, ORDER_CASHBACK, CASHBACK_EXPIRED, CASHBACK_EARNED ORDER_RETURN')"`
	AddedUser int       `gorm:"column:added_user;type:bigint(20)"`
	Expiry    time.Time `gorm:"column:expiry;type:timestamp"`
	CreatedAt time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:timestamp"`
}
type UserEAV struct {
	Entity    string    `gorm:"column:entity;primary_key;type:varchar(255)"`
	Attribute string    `gorm:"column:attribute;primary_key;type:enum('EXCLUSIVE_NOTIFY','EXCLUSIVE_EXPIRY, EXCLUSIVE_MEMBER’)"`
	Value     string    `gorm:"column:value;type:text"`
	Active    int       `gorm:"column:is_active;type:tinyint(1)"`
	CreatedAt time.Time `gorm:"column:created_at;type:datetime"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:datetime"`
}
type TssMoneyHistory struct {
	ID        uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	UserID    int       `gorm:"column:user_id;type:bigint(20)"`
	OrderID   int       `gorm:"column:order_id;type:bigint(20)"`
	AddedAmt  float64   `gorm:"column:added_amt;type:double"`
	UsedAmt   float64   `gorm:"column:used_amt;type:double"`
	AmtBefore float64   `gorm:"column:amt_before_update;type:double"`
	AmtAfter  float64   `gorm:"column:amt_after_update;type:double"`
	Comment   string    `gorm:"column:comment;type:text"`
	Platform  string    `gorm:"column:platform;type:enum('ORDER_PLACED, ORDER_CANCELLED, ORDER_REFUND, ORDER_MONEY, TSS_MONEY_EXPIRED, TSS_MONEY_EARNED ORDER_RETURN PAYMENT_FAILED DONATION_MONEY')"`
	AddedUser int       `gorm:"column:added_user;type:bigint(20)"`
	Expiry    time.Time `gorm:"column:expiry;type:timestamp"`
	CreatedAt time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:timestamp"`
	IsExpired int       `gorm:"column:is_expired;type:tinyint(1);default:0"`
}
type OrderTssMoney struct {
	ID         uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	TssMoneyID uint      `gorm:"column:tss_money_id;type:bigint(20)"`
	OrderID    int       `gorm:"column:order_id;type:bigint(20)"`
	UsedAmount float32   `gorm:"column:used_amount;type:double"`
	CreatedAt  time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt  time.Time `gorm:"column:updated_at;type:timestamp"`
}
type TssPointHistory struct {
	ID             uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	UserID         int       `gorm:"column:user_id;type:bigint(20)"`
	OrderID        int       `gorm:"column:order_id;type:bigint(20)"`
	GameCategoryId int       `gorm:"column:game_category_id;type:bigint(20)"`
	AddedAmt       float64   `gorm:"column:added_amt;type:double"`
	UsedAmt        float64   `gorm:"column:used_amt;type:double"`
	AmtBefore      float64   `gorm:"column:amt_before_update;type:double"`
	AmtAfter       float64   `gorm:"column:amt_after_update;type:double"`
	Comment        string    `gorm:"column:comment;type:text"`
	Platform       string    `gorm:"column:platform;type:enum('ORDER_PLACED, ORDER_CANCELLED, ORDER_REFUND, ORDER_POINTS, TSS_POINTS_EXPIRED, TSS_POINTS_EARNED, ORDER_RETURN, PAYMENT_FAILED, DONATION_POINTS, DONATION_POINTS_1')"`
	AddedUser      int       `gorm:"column:added_user;type:bigint(20)"`
	Expiry         time.Time `gorm:"column:expiry;type:timestamp"`
	CreatedAt      time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt      time.Time `gorm:"column:updated_at;type:timestamp"`
	IsExpired      int       `gorm:"column:is_expired;type:tinyint(1);default:0"`
}
type OrderTssPoint struct {
	ID         uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	TssPointID uint      `gorm:"column:tss_point_id;type:bigint(20)"`
	OrderID    int       `gorm:"column:order_id;type:bigint(20)"`
	UsedAmount float32   `gorm:"column:used_amount;type:double"`
	CreatedAt  time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt  time.Time `gorm:"column:updated_at;type:timestamp"`
}
type GiftVoucherHistory struct {
	ID        uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	UserID    int       `gorm:"column:user_id;type:bigint(20)"`
	OrderID   int       `gorm:"column:order_id;type:bigint(20)"`
	GvID      uint      `gorm:"column:gv_id;type:bigint(20)"`
	AddedAmt  float64   `gorm:"column:added_amt;type:double"`
	AmtBefore float64   `gorm:"column:amt_before_update;type:double"`
	AmtAfter  float64   `gorm:"column:amt_after_update;type:double"`
	Comment   string    `gorm:"column:comment;type:text"`
	Platform  string    `gorm:"column:platform;type:enum('ORDER_PLACED, ORDER_CANCELLED, ORDER_REFUND, ORDER_MONEY, ORDER_RETURN, PAYMENT_FAILED, PRODUCT_RETURN, COURIER_COMPENSATION, DEFECTIVE_PRODUCT, PRODUCT_MISSING, PRODUCT_OUT_OF_STOCK, MISC_COMPENSATION')"`
	AddedUser int       `gorm:"column:added_user;type:bigint(20)"`
	CreatedAt time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:timestamp"`
}
type OrderCouponLog struct {
	ID        uint      `gorm:"column:id;type:bigint(20);primary_key;AUTO_INCREMENT"`
	UserID    int       `gorm:"column:user_id;type:bigint(20)"`
	OrderID   int       `gorm:"column:order_id;type:bigint(20)"`
	CouponID  int       `gorm:"column:coupon_id;type:bigint(20)"`
	Status    int       `gorm:"column:status;type:int(11)"`
	CreatedAt time.Time `gorm:"column:created_at;type:timestamp"`
	UpdatedAt time.Time `gorm:"column:updated_at;type:timestamp"`
}

func (UserEAV) TableName() string {
	return "user_eav"
}
func (GiftVoucher) TableName() string {
	return "gift_vouchers"
}
func (Order) TableName() string {
	return "orders"
}
func (Product) TableName() string {
	return "products"
}
func (HasProduct) TableName() string {
	return "has_products"
}
func (RewardPointHistory) TableName() string {
	return "reward_point_history"
}
func (TssMoneyHistory) TableName() string {
	return "tss_money_history"
}
func (OrderTssMoney) TableName() string {
	return "order_tss_money"
}
func (TssPointHistory) TableName() string {
	return "tss_point_history"
}
func (OrderTssPoint) TableName() string {
	return "order_tss_point"
}
func (GiftVoucherHistory) TableName() string {
	return "gift_voucher_history"
}
func (OrderCouponLog) TableName() string {
	return "order_coupon_log"
}
func listContains(s []string, e string) bool {
	for _, a := range s {
		if a == e {
			return true
		}
	}
	return false
}
func getExpiryDelta(prodId string) int {
	var exclusiveUpgrade = map[string]map[string]int{}
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_365")] = map[string]int{}
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_330")] = map[string]int{}
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_270")] = map[string]int{}
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_365")]["expiry_delta"] = 365
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_330")]["expiry_delta"] = 330
	exclusiveUpgrade[os.Getenv("EXCLUSIVE_UPGRADE_270")]["expiry_delta"] = 270
	var expiry_delta, ok = exclusiveUpgrade[prodId]["expiry_delta"]
	if ok {
		return expiry_delta
	}
	return 0
}
func contains(s []int, str int) bool {
	for _, v := range s {
		if v == str {
			return true
		}
	}
	return false
}
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
