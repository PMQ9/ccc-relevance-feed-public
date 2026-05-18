# ccc-relevance-feed-public

Public publication endpoint for the Vanderbilt CCC marcomms relevance feed. **This repo is auto-generated — do not edit manually.** Anything pushed by hand will be overwritten on the next cron run.

## What's here

- **[`feed.json`](feed.json)** — current snapshot of CCC-relevant posts discovered across Vanderbilt websites, Google News, Google Alerts, Talkwalker, and (later) Meta Graph public pages. Force-pushed every 30 minutes during working hours (M–F, 13:00–21:00 UTC) by a GitHub Actions cron in the private source repo.
- **[`feed_v1.schema.json`](feed_v1.schema.json)** — JSON Schema for `feed.json`. Backward-compatible (additive-only) within v1.x.

## Consuming the feed

Read directly with no token:

```bash
curl -s https://raw.githubusercontent.com/PMQ9/ccc-relevance-feed-public/main/feed.json | jq .
```

Or fetch + validate:

```python
import json, urllib.request
from jsonschema import Draft202012Validator

feed = json.loads(urllib.request.urlopen(
    "https://raw.githubusercontent.com/PMQ9/ccc-relevance-feed-public/main/feed.json"
).read())
schema = json.loads(urllib.request.urlopen(
    "https://raw.githubusercontent.com/PMQ9/ccc-relevance-feed-public/main/feed_v1.schema.json"
).read())
Draft202012Validator(schema).validate(feed)

for post in feed["posts"]:
    print(post["score"], post["title"], post["url"])
```

Top-level fields: `schema_version`, `generated_at`, `scoring_version`, `posts[]`, `linkedin_saved_searches[]`, `collector_status{}`. See the schema for the full shape.

## Source

The ingestion pipeline and full architecture live in the private source repo `PMQ9/ccc-marcomms-agent-v3`, under `relevance_feed/`.
