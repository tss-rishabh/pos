package poscheckout

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestImportCouponCanonicalBenefitHash(t *testing.T) {
	value := importCouponConsumption{Contract: ImportCouponConsumptionContract, Changes: []importCouponChange{{ID: "9007199254740993", Before: "0", After: "1", InputHash: strings.Repeat("a", 64)}}}
	raw, _ := json.Marshal(value)
	var original map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if decoder.Decode(&original) != nil {
		t.Fatal("bad fixture")
	}
	first, err := importBenefitMAC(strings.Repeat("fixture-", 8), "coupon-consumption", value)
	second, otherErr := importMAC(strings.Repeat("fixture-", 8), "legacy-order-imports.source.benefit.coupon-consumption.v1", original)
	if err != nil || otherErr != nil || first != second {
		t.Fatal("benefit struct ordering differs from canonical map protocol")
	}
}
