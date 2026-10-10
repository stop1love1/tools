# Auto-Detect Repo Selection Feature

## Overview

This feature automatically selects the appropriate Git repositories based on the **prefix** (key) at the beginning of a task's title/summary in Jira.

## How It Works

When you open the "Start" dialog for a task (by clicking the "Claude" button or "Start" in the drawer), the system now intelligently detects which repos should be selected by default based on your task title.

### Supported Patterns

The system recognizes multiple prefix formats:

| Pattern | Example | Repos Selected |
|---------|---------|-----------------|
| `[FE]` | `[FE] Add button component` | Frontend |
| `FE:` | `FE: Add button component` | Frontend |
| `FE,` | `FE, Add button component` | Frontend |
| `FE-` | `FE-Add button component` | Frontend |
| `FE/` | `FE/BE: Full stack feature` | Frontend, Backend |
| `FE ` (with space) | `FE Add button component` | Frontend |
| `[BE]` | `[BE] Fix API bug` | Backend |
| `BE:` | `BE: Fix API bug` | Backend |
| `[TOOLS]` | `[TOOLS] Update CLI` | Tools |
| `TOOLS:` | `TOOLS: Update CLI` | Tools |

### Multi-Repo Selection

You can combine multiple prefixes to select multiple repos:

- `[FE][BE] Full stack course feature` → Selects **Frontend** + **Backend**
- `FE/BE: Implement filtering` → Selects **Frontend** + **Backend**
- `[FE][TOOLS] Component library` → Selects **Frontend** + **Tools**

### Default Behavior

- If **no recognized prefix** is found, defaults to the first repo (Frontend)
- If a pattern doesn't match any repos, falls back to first repo
- Maximum 5 prefixes are extracted from the beginning of the title

### Tag Aliases

The system recognizes multiple spellings:

- **Frontend**: `FE`, `FRONTEND`
- **Backend**: `BE`, `BACKEND`
- **Tools**: `TOOLS`

## Implementation Details

The feature is implemented in `/jira/public/js/git/start.js` in the `guessRepos()` function.

### Key Changes

```javascript
// Before: Simple regex matching only [FE] or BE with word boundary
function guessRepos(issue) {
  const tag = issue.summary.match(/^\W*(FE|BE)\b/i)?.[1].toLowerCase();
  const named = tag && gitRepos().filter((r) => r.startsWith(tag[0] === 'f' ? 'front' : 'back'));
  return named?.length ? named : gitRepos().slice(0, 1);
}

// After: Comprehensive pattern matching with multiple formats
function guessRepos(issue) {
  // Extracts: [FE], FE:, FE, FE-, FE/, and combinations
  // Supports FE, BE, TOOLS, FRONTEND, BACKEND
  // Returns array of matching repos
}
```

## Testing

The feature was validated with 14 comprehensive test cases:

✓ `[FE]` pattern  
✓ `FE:` pattern  
✓ `FE,` pattern  
✓ `FE` (space) pattern  
✓ `FE-` pattern  
✓ `BE:` pattern  
✓ `[BE]` pattern  
✓ `[FE][BE]` combined  
✓ `FE/BE` pattern  
✓ `[TOOLS]` pattern  
✓ `TOOLS:` pattern  
✓ No prefix (defaults to first)  
✓ `[FE][TOOLS]` combined  
✓ Mixed patterns  

All tests pass ✓

## Configuration

The repos are defined in your `config.json` under `git.repos`:

```json
{
  "git": {
    "repos": [
      { "id": "frontend", "label": "Frontend", "dir": "frontend" },
      { "id": "backend", "label": "Backend", "dir": "backend" }
    ]
  }
}
```

The function looks for repos starting with:
- `front` → Frontend repo
- `back` → Backend repo
- `tools` → Tools repo

## Usage Example

1. Open any Jira task/issue
2. Click the **"Claude"** button (or "Start" in the drawer)
3. In the "Start" popover, the repo checkboxes are **automatically pre-selected** based on your task title

**Before the update:**
- `[FE] Add course tags` → Only Frontend selected ✓ (already worked)
- `FE: Add course tags` → Only first repo selected ✗ (didn't work)
- `[FE][BE] Full stack` → Only Frontend selected ✗ (didn't work)

**After the update:**
- `[FE] Add course tags` → Frontend selected ✓
- `FE: Add course tags` → Frontend selected ✓
- `[FE][BE] Full stack` → Frontend + Backend selected ✓

You can still manually change the checkboxes if needed before clicking "Start".

## Future Enhancements

Possible improvements:
- Support for additional repo naming patterns (if new repos are added)
- Custom tag mappings via config
- Support for hyphenated prefixes like `FE-BE:`
- Analytics on which prefixes are most commonly used
