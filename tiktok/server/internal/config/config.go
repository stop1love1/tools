package config

import (
	"os"
	"strconv"
)

type Config struct {
	Port        int
	MongoURI    string
	MongoDB     string
	SignAPIKey  string
	SidecarURL  string
}

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func Load() Config {
	port, err := strconv.Atoi(env("PORT", "8080"))
	if err != nil {
		port = 8080
	}
	return Config{
		Port:       port,
		MongoURI:   env("MONGODB_URI", "mongodb://localhost:27017"),
		MongoDB:    env("MONGODB_DB", "tiktok_live"),
		SignAPIKey: os.Getenv("SIGN_API_KEY"),
		SidecarURL: env("SIDECAR_URL", "http://127.0.0.1:8500"),
	}
}
