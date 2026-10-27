#!/bin/sh
set -e

echo "=== Popcorn Setup ==="
echo

# Check prerequisites
command -v bun >/dev/null 2>&1 || { echo "Error: bun is required but not installed. Visit https://bun.sh"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: docker is required but not installed."; exit 1; }

# Install dependencies
echo "Installing dependencies..."
(cd app && bun install)
(cd backend && bun install)
echo

# Create backend/.env if it doesn't exist
if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "Created backend/.env from backend/.env.example"
else
  echo "backend/.env already exists, skipping"
fi
echo

# Create the root Compose environment with a local-only database password.
if [ ! -f .env ]; then
  DB_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
  cat > .env <<EOF
POSTGRES_USER=popcorn
POSTGRES_PASSWORD=$DB_PASSWORD
POSTGRES_DB=popcorn
LOG_HTML=false
EOF
  echo "Created .env with a randomly generated database password"
else
  echo ".env already exists, skipping"
fi
echo

# Start services to generate Jackett config
echo "Starting services (this may take a moment on first run)..."
sudo docker compose -f ./compose.services.yaml up -d

# Wait for Jackett to generate its config
echo "Waiting for Jackett to initialize..."
i=0
while [ $i -lt 30 ]; do
  if [ -f "jackett/config/ServerConfig.json" ]; then
    break
  fi
  sleep 1
  i=$((i + 1))
done

if [ ! -f "jackett/config/ServerConfig.json" ]; then
  echo "Warning: Jackett config not generated yet. You may need to wait longer or check docker logs."
else
  # Extract API key and update backend/.env
  API_KEY=$(grep -o '"APIKey": "[^"]*"' jackett/config/ServerConfig.json | cut -d'"' -f4)
  if [ -n "$API_KEY" ]; then
    if grep -q "^JACKETT_API_KEY=your_api_key_here" backend/.env 2>/dev/null; then
      sed -i "s/^JACKETT_API_KEY=your_api_key_here/JACKETT_API_KEY=$API_KEY/" backend/.env
      echo "Jackett API key configured automatically"
    elif grep -q "^JACKETT_API_KEY=" backend/.env 2>/dev/null; then
      echo "Jackett API key already configured in backend/.env"
    fi
  fi

  # Configure FlareSolverr URL if not already set
  if grep -q '"FlareSolverrUrl": null' jackett/config/ServerConfig.json 2>/dev/null; then
    sed -i 's|"FlareSolverrUrl": null|"FlareSolverrUrl": "http://flaresolverr:8191"|' jackett/config/ServerConfig.json
    echo "FlareSolverr URL configured in Jackett"
    # Restart Jackett to pick up config change
    sudo docker compose -f ./compose.services.yaml restart jackett
  fi
fi
echo

echo "=== Setup Complete ==="
echo
echo "Services running:"
echo "  - Jackett:      http://localhost:9117"
echo "  - Transmission: http://localhost:9091"
echo "  - FlareSolverr: http://localhost:8191"
echo
echo "Next steps:"
echo "  1. Open Jackett and add an indexer (e.g., 1337x)"
echo "  2. Start the backend:  cd backend && bun run dev"
echo "  3. Start the frontend: cd app && bun run dev"
echo "  4. Open http://localhost:3000"
