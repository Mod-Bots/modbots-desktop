# Mod Bots Desktop

Mod Bots Desktop is the Tauri desktop client for the Mod Bots platform.

## Development prerequisites

- Windows
- Node.js 22 or newer
- npm
- Rust
- The Tauri system prerequisites
- The Mod Bots backend running locally

## Run for development

Install dependencies and create the local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Start the backend from the backend repository:

```powershell
docker compose up --detach
```

Start the desktop app in development mode:

```powershell
npm run tauri dev
```

## License

This project is licensed under the [MIT License](LICENSE.md).

## Copyright

Copyright &copy; 2026 William Sawyerr.
