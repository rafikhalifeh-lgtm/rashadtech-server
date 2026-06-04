#!/bin/bash
# RashadTech Setup Script - Saves credentials permanently
# Run this once, and credentials persist for all future sessions

echo "=== RashadTech.tv Credential Setup ==="
echo ""

# Netlify Token
echo "Enter your Netlify Personal Access Token:"
read -p "Token (from https://app.netlify.com/user/applications): " netlify_token
echo "export NETLIFY_TOKEN=\"$netlify_token\"" >> ~/.bashrc
echo "export NETLIFY_SITE_ID=\"a7d17faa-56f4-42ff-bcba-80bc99b2e4d5\"" >> ~/.bashrc
echo "export NETLIFY_SITE_NAME=\"rashadtechtv\"" >> ~/.bashrc
echo "✅ Netlify saved"

# GitHub Token
echo ""
echo "Enter your GitHub Personal Access Token:"
read -p "Token (from https://github.com/settings/tokens): " github_token
echo "export GITHUB_TOKEN=\"$github_token\"" >> ~/.bashrc
echo "✅ GitHub saved"

# Server URL
echo ""
echo "export SERVER_URL=\"https://rashadtech-server.onrender.com\"" >> ~/.bashrc

# JSONBin
echo "export JSONBIN_SECRET=\"rashadtech2026secret\"" >> ~/.bashrc
echo "export JSONBIN_ID=\"6a1eb713f5f4af5e29ac8d17\"" >> ~/.bashrc

# Telegram
echo "export TELEGRAM_BOT_TOKEN=\"8761505457:AAEsL3r6rN29VTBd-cDuufrYHt1TFbW3uFs\"" >> ~/.bashrc

echo ""
echo "=== All Credentials Saved! ==="
echo "These will be available in every future session."
echo ""
echo "To apply now, run: source ~/.bashrc"