// Run as a supervised worker in the reviewed payments deployment. Compiling
// this command never starts it; isolated tests inject their own database/HTTP.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"
	"time"

	"backend-tss-domestic_payments_api/internal/poscheckout"
	"backend-tss-domestic_payments_api/utils"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	handlers, err := poscheckout.HTTPHandlers(os.Getenv, false)
	if err != nil || utils.Db == nil {
		os.Stderr.WriteString("{\"eventId\":\"payments.pos-checkout-effects.startup-failed\",\"module\":\"payments\",\"resource\":\"pos-checkout-effects\",\"requestId\":null,\"userId\":null}\n")
		os.Exit(1)
	}
	database := utils.Db.DB()
	for {
		err = poscheckout.Dispatch(ctx, database, handlers, 100, func(value poscheckout.Outcome) { poscheckout.LogOutcome(os.Stdout, value) })
		if err != nil && ctx.Err() == nil {
			os.Stderr.WriteString("{\"eventId\":\"payments.pos-checkout-effects.dispatch-failed\",\"module\":\"payments\",\"resource\":\"pos-checkout-effects\",\"requestId\":null,\"userId\":null}\n")
		}
		timer := time.NewTimer(5 * time.Second)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
	}
}
