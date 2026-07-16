package main

import (
	"fmt"
	"log"
	"net/http"

	"tiktok-live-server/internal/config"
	"tiktok-live-server/internal/httpapi"
	"tiktok-live-server/internal/hub"
	"tiktok-live-server/internal/store"
)

func main() {
	cfg := config.Load()

	st := store.Connect(cfg.MongoURI, cfg.MongoDB)
	h := hub.New(st, cfg.SignAPIKey)
	api := httpapi.New(h, st, cfg.SidecarURL)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("TikTok LIVE server chạy tại http://localhost%s", addr)
	log.Printf("  WS bridge : ws://localhost%s/ws?user=<username>", addr)
	log.Printf("  Data proxy: http://localhost%s/api/data/* -> %s", addr, cfg.SidecarURL)
	if err := http.ListenAndServe(addr, api.Routes()); err != nil {
		log.Fatal(err)
	}
}
