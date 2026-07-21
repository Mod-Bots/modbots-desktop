# Mod Bots Desktop

Mod Bots Desktop is the Tauri desktop client for the Mod Bots platform.

## Prerequisites

- Node.js 22 or newer
- Rust and the Tauri system prerequisites

## Run

Install dependencies and create the local environment file:

```powershell
npm install
Copy-Item .env.example .env
```

Start the [Mod Bots backend](https://github.com/wsucauid798/modbots-backend) in
another terminal.

Start the desktop app:

```powershell
npm run tauri dev
```

## License

This project is licensed under the [MIT License](LICENSE.md).

## Copyright

Copyright &copy; 2026 William Sawyerr.
