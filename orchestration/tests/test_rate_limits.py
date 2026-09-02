from __future__ import annotations

import time
import unittest

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


if __name__ == "__main__":
    unittest.main()

