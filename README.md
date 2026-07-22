# Mod Bots Desktop

![Version: 0.0.1-alpha](https://img.shields.io/badge/version-0.0.1--alpha-14b8a6)
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![Branch: release/v0.0.1-alpha](https://img.shields.io/badge/branch-release%2Fv0.0.1--alpha-64748b)
[![CI](https://github.com/wsucauid798/modbots-desktop/actions/workflows/ci.yml/badge.svg?branch=release/v0.0.1-alpha)](https://github.com/wsucauid798/modbots-desktop/actions/workflows/ci.yml)
![Tauri](https://img.shields.io/badge/app-Tauri-24C8DB?logo=tauri&logoColor=white)
![Vite](https://img.shields.io/badge/dev-Vite-646CFF?logo=vite&logoColor=white)
![Node.js 24](https://img.shields.io/badge/node-24-339933?logo=node.js&logoColor=white)
![React 19](https://img.shields.io/badge/react-19-61DAFB?logo=react&logoColor=111827)

Mod Bots Desktop is the Tauri desktop client for the Mod Bots platform.

## Prerequisites

- Node.js 24 or newer
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
