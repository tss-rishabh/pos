package poscheckout

import "testing"

func TestImportActorJSONMatchesNodeFingerprint(t *testing.T) {
	cases := []struct {
		values   []interface{}
		expected string
	}{
		{[]interface{}{"operator<&>", nil, true, 3}, `["operator<&>",null,true,3]`},
		{[]interface{}{"अ\u2028\u2029", `literal\u2028`, "\n\t\x01"}, "[\"अ\u2028\u2029\"," + `"literal\\u2028","\n\t\u0001"]`},
	}
	for _, value := range cases {
		encoded, err := importActorJSON(value.values)
		if err != nil || string(encoded) != value.expected {
			t.Fatal("operator fingerprint JSON differs from Node encoding")
		}
	}
}
