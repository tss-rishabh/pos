package sourcefixture

import (
	"os"
	"strings"

	"backend-tss-domestic_payments_api/internal/poscheckout"

	"github.com/gbrlsnchs/jwt"
	"github.com/gin-gonic/gin"
)

// use jwt.FromString("jwt_token_here") to read and then .Verify on the return value with jwt.HS256("secret") to validate it and use it.
func AuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Method == "OPTIONS" {
			//skip this method.
			return
		}

		jwtToken := c.GetHeader("Authorization")
		twoFa := false

		//check if auth header exists
		if len(jwtToken) == 0 {
			//no header set. return
			return
		}

		// 2 Factor auth Token. HasPrefix rather than jwtToken[:3], which panics
		// on a one or two character Authorization header.
		if strings.HasPrefix(jwtToken, "2f.") {
			jwtToken = strings.TrimPrefix(jwtToken, "2f.")
			twoFa = true
		}

		//Load JWT token
		jot, err := jwt.FromString(jwtToken)

		if err != nil {
			// handler responds 401 because user_id is never set.
			poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationRejected)
			return
		}

		if twoFa {
			if err = jot.Verify(jwt.HS512(os.Getenv("JWT_KEY_512"))); err != nil {
				// Handle verification error...
				poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationRejected)
				return
			}
		} else {
			if err = jot.Verify(jwt.HS256(os.Getenv("JWT_KEY"))); err != nil {
				// Handle verification error...
				poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationRejected)
				return
			}
		}

		userId := jot.Subject()
		poscheckout.RecordHTTPEvent(c.Request.Context(), poscheckout.AuthenticationAccepted)

		//user_id := "24353"
		c.Set("user_id", userId)
		c.Next()
	}
}
