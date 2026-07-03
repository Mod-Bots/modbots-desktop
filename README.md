# Mod Bots Desktop

The primary desktop client for Mod Bots. It is built with Tauri 2, Rust,
React, TypeScript, Vite, and TanStack Query.

## Prerequisites

- Windows
- Node.js 22 or newer
- npm
- Rust
- Tauri prerequisites for your platform
- the Mod Bots backend stack running from the parent repository

## Install

```powershell
npm install
```

Copy the optional local endpoint defaults if they need to be changed:

```powershell
Copy-Item .env.example .env
```

## Development

Start the backend stack from the parent repository:

```powershell
docker compose up --detach
```

Then run the desktop app:

```powershell
npm run tauri dev
```

If you only want the frontend dev server:

```powershell
npm run dev
```

The standalone frontend server cannot use the Tauri-native HTTP client. Use
`npm run tauri dev` when validating live backend connectivity.

## Build

Build the frontend bundle:

```powershell
npm run build
```

Build the desktop application:

```powershell
npm run tauri build
```

## Configuration

The desktop defaults are:

- API: `http://localhost:3001`
- realtime configuration: `http://localhost:3002/v1/realtime/config`
- realtime health: `http://localhost:3002/health`

Override them with the `VITE_MODBOTS_API_URL`,
`VITE_MODBOTS_REALTIME_CONFIG_URL`, and
`VITE_MODBOTS_REALTIME_HEALTH_URL` environment variables.

## License

&copy; 2026 William Sawyerr. See [License](LICENSE) for more details.
