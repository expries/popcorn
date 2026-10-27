#!/bin/sh
# Start only external services (jackett, transmission, flaresolverr)
# Run backend locally with: cd backend && bun run dev
sudo docker compose -f ./compose.services.yaml $1
