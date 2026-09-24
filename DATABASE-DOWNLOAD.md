# RashadTech Database Download

Your full recovered database (**87 users**, **272 stock accounts**) is available on GitHub in this folder.

## Download (works from any browser)

1. Open this link:  
   **https://github.com/rafikhalifeh-lgtm/rashadtech-server/raw/main/handoff/rashadtech-database-handoff.zip**

2. Save the file (`rashadtech-database-handoff.zip`, ~958 KB).

3. Unzip with password: **`RashadTechDB2026!`**

   - **Windows:** Right-click → Extract with 7-Zip / WinRAR → enter password when asked  
   - **Mac:** Double-click in Finder, or use Keka / The Unarchiver  
   - **Command line:** `unzip -P 'RashadTechDB2026!' rashadtech-database-handoff.zip`

## Inside the zip

| File | Description |
|------|-------------|
| `rashadtech-database.json` | Full database (~7.2 MB) |
| `rashadtech-database.sql` | MySQL-compatible SQL (~846 KB) |

## Security

- The zip is password-protected because this repo is public.
- After downloading, **change the password** or move files to a private folder.
- Do not share the zip or password publicly — it contains real customer and stock credentials.

## After you have the files

Rotate secrets (Netlify token, admin passwords) if they were ever exposed in chat or logs.
