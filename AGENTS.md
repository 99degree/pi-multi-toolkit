# AGENTS.md

## Session
**Session ID**: session-1781803389185-1yovkf
**Created**: 2026-06-19

## Context
This file documents the active session and agent configuration.

## Extensions
- pi-replace-tool: Enhanced replace with content dump on no-match
- pi-multi-subs: Interactive subscription manager (/subs)
- pi-multi-pass: Interactive route manager (/route)
- pi-session-id: Session tracking and Mistral role fixes

## Rules
- Use ctx.ui.notify(message, level) for all inline output
- Use Node.js fs/promises for file operations
- Provisioned providers selectable via ctx.ui.select()
- Cloned provider names auto-generated as -N suffix
- Session ID injected into system prompts for Mistral compatibility
