from __future__ import annotations

import time
import unittest
from datetime import UTC, datetime

from agentctl.codex import classify_rate_limit


class RateLimitTests(unittest.TestCase):
    def test_non_rate_failure_is_not_misclassified(self) -> None:
        limited, retry_at = classify_rate_limit("authentication failed", 900)
        self.assertFalse(limited)
        self.assertIsNone(retry_at)

    def test_relative_retry_is_parsed(self) -> None:
        before = time.time()
        limited, retry_at = classify_rate_limit("HTTP 429 rate limit; try again in 2 minutes", 900)
        self.assertTrue(limited)
        assert retry_at is not None
        self.assertGreaterEqual(retry_at, before + 119)
        self.assertLess(retry_at, before + 122)

    def test_fallback_is_bounded(self) -> None:
        before = time.time()
        limited, retry_at = classify_rate_limit("usage limit reached", 37)
        self.assertTrue(limited)
        assert retry_at is not None
        self.assertGreaterEqual(retry_at, before + 36)
        self.assertLess(retry_at, before + 39)

    def test_multiday_usage_limit_message_is_parsed_as_absolute_date(self) -> None:
        message = (
            "You've hit your usage limit. Upgrade to Pro "
            "(https://chatgpt.com/explore/pro), visit "
            "https://chatgpt.com/codex/settings/usage to purchase more credits "
            "or try again at Sep 19th, 2026 2:33 PM."
        )
        limited, retry_at = classify_rate_limit(message, 900)
        self.assertTrue(limited)
        assert retry_at is not None
        expected = datetime(2026, 9, 19, 14, 33, tzinfo=UTC).timestamp()
        self.assertAlmostEqual(retry_at, expected, delta=1)

    def test_absolute_date_without_ordinal_suffix_is_parsed(self) -> None:
        limited, retry_at = classify_rate_limit(
            "usage limit reached; try again at January 3, 2027 9:05 AM", 900
        )
        self.assertTrue(limited)
        assert retry_at is not None
        expected = datetime(2027, 1, 3, 9, 5, tzinfo=UTC).timestamp()
        self.assertAlmostEqual(retry_at, expected, delta=1)


if __name__ == "__main__":
    unittest.main()

