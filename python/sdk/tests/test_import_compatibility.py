"""Canonical Python package imports and their legacy compatibility aliases."""

from __future__ import annotations


def test_sdk_legacy_module_reexports_canonical_implementation() -> None:
    import deepseek_harness as legacy
    import yharness as canonical
    from deepseek_harness.api import DeepSeekHarness, DeepSeekHarnessConfig

    assert canonical.YHarness is canonical.DeepSeekHarness
    assert canonical.YHarnessConfig is canonical.DeepSeekHarnessConfig
    assert legacy.YHarness is canonical.YHarness
    assert legacy.DeepSeekHarness is canonical.YHarness
    assert DeepSeekHarness is canonical.YHarness
    assert DeepSeekHarnessConfig is canonical.YHarnessConfig


def test_runtime_legacy_module_keeps_metadata_and_mode_aliases() -> None:
    import deepseek_harness_runtime as legacy
    import yharness_runtime as canonical

    assert legacy.PACKAGE_METADATA_FILENAME == "deepseek-harness-runtime.json"
    assert canonical.PACKAGE_METADATA_FILENAME == "yharness-runtime.json"
    assert legacy.LEGACY_PACKAGE_METADATA_FILENAME == canonical.LEGACY_PACKAGE_METADATA_FILENAME
    assert legacy.RUNTIME_MODE_ENV_VAR == canonical.RUNTIME_MODE_ENV_VAR
    assert legacy.LEGACY_RUNTIME_MODE_ENV_VAR == canonical.LEGACY_RUNTIME_MODE_ENV_VAR
