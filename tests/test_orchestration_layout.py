import os
import sys
from pathlib import Path

import pytest

import ai_video_workflow.orchestration as orchestration_package
import ai_video_workflow.orchestration.layout as layout_module
from ai_video_workflow.errors import FieldTypeError, InvariantViolationError
from ai_video_workflow.orchestration import (
    InvalidOrchestrationInputError,
    PersistenceExecutionError,
)
from ai_video_workflow.orchestration.layout import _LayoutResolver, _StateLayout

RUNNING_AS_ROOT = hasattr(os, "geteuid") and os.geteuid() == 0


@pytest.fixture
def project_root(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    root.mkdir()
    return root


@pytest.fixture
def resolver(project_root: Path) -> _LayoutResolver:
    return _LayoutResolver(project_root)


class TestDerivedPaths:
    def test_four_paths_are_distinct_and_match_task_id(
        self,
        resolver: _LayoutResolver,
        project_root: Path,
    ) -> None:
        layout = resolver.resolve_state_layout("task-42")
        assert isinstance(layout, _StateLayout)
        assert layout.task_path == (
            project_root / "records/generation-tasks/task-42.json"
        )
        assert layout.manifest_path == (
            project_root / "manifests/generation-task-42.json"
        )
        assert layout.record_path == (
            project_root / "records/orchestration/task-42.json"
        )
        assert layout.instruction_path == (
            project_root / "tasks/instructions/task-42.md"
        )
        targets = layout.targets()
        assert len({str(target) for target in targets}) == 4
        assert layout.task_id == "task-42"

    def test_all_targets_are_inside_the_root(
        self,
        resolver: _LayoutResolver,
        project_root: Path,
    ) -> None:
        layout = resolver.resolve_state_layout("task-1")
        for target in layout.targets():
            assert project_root in target.parents

    def test_deterministic_paths_do_not_depend_on_cwd(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        first = _LayoutResolver(root).resolve_state_layout("task-1")
        other_cwd = tmp_path / "elsewhere"
        other_cwd.mkdir()
        monkeypatch.chdir(other_cwd)
        second = _LayoutResolver(root).resolve_state_layout("task-1")
        assert first == second

    def test_repeated_resolution_is_stable(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        assert resolver.resolve_state_layout("task-1") == (
            resolver.resolve_state_layout("task-1")
        )

    def test_root_is_absolutized_and_lexically_normalized(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        messy = str(root) + "/sub/.."
        resolver = _LayoutResolver(messy)
        assert resolver.project_root == root


class TestRootAndTaskIdInputContract:
    def test_relative_root_is_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            _LayoutResolver("relative/project")

    def test_empty_and_blank_root_are_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            _LayoutResolver("")
        with pytest.raises(InvalidOrchestrationInputError):
            _LayoutResolver("   ")

    def test_nul_in_root_is_rejected(self) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            _LayoutResolver("/tmp/pro\x00ject")

    @pytest.mark.parametrize("value", [1, None, 3.5, b"/abs", ["/abs"]])
    def test_non_path_root_is_rejected(self, value: object) -> None:
        with pytest.raises(FieldTypeError):
            _LayoutResolver(value)

    def test_str_and_path_roots_are_equivalent(self, tmp_path: Path) -> None:
        root = tmp_path / "project"
        root.mkdir()
        via_str = _LayoutResolver(str(root)).resolve_state_layout("task-1")
        via_path = _LayoutResolver(root).resolve_state_layout("task-1")
        assert via_str == via_path

    @pytest.mark.parametrize(
        "task_id",
        [
            "../evil",
            "a/b",
            "a\\b",
            "/abs",
            ".",
            "..",
            "x/../y",
            "sub/task",
        ],
    )
    def test_path_unsafe_task_ids_are_rejected(
        self,
        resolver: _LayoutResolver,
        task_id: str,
    ) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            resolver.resolve_state_layout(task_id)

    @pytest.mark.parametrize("task_id", ["", "   ", "\t"])
    def test_empty_or_blank_task_id_is_rejected(
        self,
        resolver: _LayoutResolver,
        task_id: str,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            resolver.resolve_state_layout(task_id)

    def test_nul_task_id_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(InvariantViolationError):
            resolver.resolve_state_layout("task\x001")

    @pytest.mark.parametrize("value", [1, None, 3.5, b"task"])
    def test_non_string_task_id_is_rejected(
        self,
        resolver: _LayoutResolver,
        value: object,
    ) -> None:
        with pytest.raises(FieldTypeError):
            resolver.resolve_state_layout(value)


class TestStateTargetSymlinkSafety:
    def test_symlink_ancestor_escaping_root_is_rejected(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "records").mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        os.symlink(outside, root / "records/generation-tasks")
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_state_layout("task-1")

    def test_symlink_ancestor_staying_in_root_is_allowed(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "real-records").mkdir()
        os.symlink(root / "real-records", root / "records")
        resolver = _LayoutResolver(root)
        layout = resolver.resolve_state_layout("task-1")
        assert layout.task_id == "task-1"

    def test_missing_target_tree_is_safe(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        # No directories exist yet; derivation and safety must still work.
        layout = resolver.resolve_state_layout("task-1")
        assert not layout.task_path.exists()


class TestArtifactComparison:
    def test_non_local_reference_returns_none(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        result = resolver.resolve_local_artifact_comparison(
            "records/generation-tasks/task-1.json",
            is_local=False,
        )
        assert result is None

    def test_safe_local_reference_returns_comparison_path(
        self,
        resolver: _LayoutResolver,
        project_root: Path,
    ) -> None:
        result = resolver.resolve_local_artifact_comparison(
            "staging/clip.mp4",
            is_local=True,
        )
        assert result == project_root / "staging/clip.mp4"

    def test_absolute_reference_outside_root_is_not_a_state_collision(
        self,
        resolver: _LayoutResolver,
        tmp_path: Path,
    ) -> None:
        elsewhere = tmp_path / "elsewhere/clip.mp4"
        result = resolver.resolve_local_artifact_comparison(
            str(elsewhere),
            is_local=True,
        )
        assert result == elsewhere

    def test_reference_to_current_task_file_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "records/generation-tasks/task-1.json",
                is_local=True,
            )

    def test_reference_to_other_task_file_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "records/generation-tasks/other-task.json",
                is_local=True,
            )

    @pytest.mark.parametrize(
        "reference",
        [
            "records/generation-tasks",
            "records/generation-tasks/sub/clip.mp4",
            "records/generation-tasks/sub",
        ],
    )
    def test_reference_into_generation_tasks_dir_is_rejected(
        self,
        resolver: _LayoutResolver,
        reference: str,
    ) -> None:
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                reference,
                is_local=True,
            )

    @pytest.mark.parametrize(
        "reference",
        [
            "manifests/generation-task-1.json",
            "manifests/anything.json",
            "manifests",
            "records/orchestration/task-1.json",
            "records/orchestration",
            "tasks/instructions/task-1.md",
            "tasks/instructions",
        ],
    )
    def test_reference_into_protected_state_dirs_is_rejected(
        self,
        resolver: _LayoutResolver,
        reference: str,
    ) -> None:
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                reference,
                is_local=True,
            )

    def test_relative_dotdot_reference_into_state_dir_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "staging/../records/orchestration/task-1.json",
                is_local=True,
            )

    def test_symlink_alias_into_protected_dir_is_rejected(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "records/orchestration").mkdir(parents=True)
        (root / "staging").mkdir()
        os.symlink(
            root / "records/orchestration",
            root / "staging/alias",
        )
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "staging/alias/task-1.json",
                is_local=True,
            )

    @pytest.mark.parametrize(
        ("link_target", "reference"),
        [
            # link -> records/generation-tasks; "link/.." climbs to
            # records, then back into a protected sibling.
            (
                "records/generation-tasks",
                "staging/link/../orchestration/task-1.json",
            ),
            # current task file reached via the symlink itself.
            (
                "records/generation-tasks",
                "staging/link/task-1.json",
            ),
            # other task file in the protected directory.
            (
                "records/generation-tasks",
                "staging/link/other.json",
            ),
            # link -> tasks/instructions; "link/.." climbs to tasks,
            # then back into the protected instructions directory.
            (
                "tasks/instructions",
                "staging/link/../instructions/task-1.md",
            ),
            # link -> records; back into manifests requires climbing to
            # root, so link -> project root here.
            (
                ".",
                "staging/link/manifests/generation-task-1.json",
            ),
        ],
    )
    def test_symlink_then_dotdot_cannot_bypass_protection(
        self,
        tmp_path: Path,
        link_target: str,
        reference: str,
    ) -> None:
        # A symlink component must be resolved to its real target before
        # any following ".." applies; it must not be lexically collapsed,
        # which would bypass the whole-directory protection.
        root = tmp_path / "project"
        root.mkdir()
        (root / "records/generation-tasks").mkdir(parents=True)
        (root / "records/orchestration").mkdir(parents=True)
        (root / "manifests").mkdir()
        (root / "tasks/instructions").mkdir(parents=True)
        (root / "staging").mkdir()
        os.symlink(root / link_target, root / "staging/link")
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(reference, is_local=True)

    def test_symlink_loop_is_conservatively_rejected(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "staging").mkdir()
        os.symlink(root / "staging/loop", root / "staging/loop")
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError) as exc_info:
            resolver.resolve_local_artifact_comparison(
                "staging/loop/clip.mp4",
                is_local=True,
            )
        assert exc_info.value.__cause__ is not None

    def test_legitimate_dotdot_staying_safe_is_accepted(
        self,
        resolver: _LayoutResolver,
        project_root: Path,
    ) -> None:
        result = resolver.resolve_local_artifact_comparison(
            "staging/sub/../clip.mp4",
            is_local=True,
        )
        assert result == project_root / "staging/clip.mp4"

    def test_existing_parent_symlink_with_nonexistent_suffix(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "staging").mkdir()
        outside = tmp_path / "outside"
        outside.mkdir()
        os.symlink(outside, root / "staging/out")
        resolver = _LayoutResolver(root)
        result = resolver.resolve_local_artifact_comparison(
            "staging/out/newfile.mp4",
            is_local=True,
        )
        assert result == outside / "newfile.mp4"

    def test_symlink_final_leaf_is_resolved(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "records/orchestration").mkdir(parents=True)
        (root / "staging").mkdir()
        os.symlink(
            root / "records/orchestration/task-1.json",
            root / "staging/leaf.json",
        )
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "staging/leaf.json",
                is_local=True,
            )

    def test_dangling_symlink_into_protected_dir_is_rejected(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "staging").mkdir()
        # Dangling: target does not exist yet, still resolves lexically.
        os.symlink(
            root / "manifests/generation-task-1.json",
            root / "staging/dangling.json",
        )
        resolver = _LayoutResolver(root)
        with pytest.raises(PersistenceExecutionError):
            resolver.resolve_local_artifact_comparison(
                "staging/dangling.json",
                is_local=True,
            )

    @pytest.mark.skipif(
        RUNNING_AS_ROOT or sys.platform == "win32",
        reason="chmod-based permission denial does not apply as root, nor on "
        "Windows (chmod cannot revoke directory access) — ADR-0049",
    )
    def test_unresolvable_existing_parent_is_conservatively_rejected(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        (root / "staging").mkdir()
        locked = root / "staging/locked"
        locked.mkdir()
        (locked / "child").mkdir()
        os.chmod(locked, 0)
        resolver = _LayoutResolver(root)
        try:
            with pytest.raises(PersistenceExecutionError) as exc_info:
                resolver.resolve_local_artifact_comparison(
                    "staging/locked/child/clip.mp4",
                    is_local=True,
                )
            assert exc_info.value.__cause__ is not None
        finally:
            os.chmod(locked, 0o700)

    def test_non_string_reference_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(FieldTypeError):
            resolver.resolve_local_artifact_comparison(1, is_local=True)

    def test_non_bool_is_local_is_rejected(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        with pytest.raises(FieldTypeError):
            resolver.resolve_local_artifact_comparison("x", is_local=1)

    @pytest.mark.parametrize("reference", ["", "   ", "clip\x00.mp4"])
    def test_empty_blank_or_nul_reference_is_rejected(
        self,
        resolver: _LayoutResolver,
        reference: str,
    ) -> None:
        with pytest.raises(InvalidOrchestrationInputError):
            resolver.resolve_local_artifact_comparison(
                reference,
                is_local=True,
            )


class TestPrefixConfusion:
    def test_sibling_directory_with_shared_prefix_is_not_protected(
        self,
        resolver: _LayoutResolver,
        project_root: Path,
    ) -> None:
        # "manifests-archive" shares a lexical prefix with "manifests"
        # but must not be treated as inside the protected directory.
        result = resolver.resolve_local_artifact_comparison(
            "manifests-archive/clip.mp4",
            is_local=True,
        )
        assert result == project_root / "manifests-archive/clip.mp4"

    def test_sibling_project_root_is_not_treated_as_inside(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        sibling = tmp_path / "project2"
        sibling.mkdir()
        resolver = _LayoutResolver(root)
        # A reference resolving into a same-prefix sibling root is not a
        # collision with this project's protected state directories.
        result = resolver.resolve_local_artifact_comparison(
            str(sibling / "manifests/clip.mp4"),
            is_local=True,
        )
        assert result == sibling / "manifests/clip.mp4"


class TestImmutabilityAndIsolation:
    def test_state_layout_is_frozen(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        layout = resolver.resolve_state_layout("task-1")
        with pytest.raises((AttributeError, TypeError)):
            layout.task_path = Path("/other")

    def test_state_layout_has_slots(
        self,
        resolver: _LayoutResolver,
    ) -> None:
        layout = resolver.resolve_state_layout("task-1")
        assert not hasattr(layout, "__dict__")

    def test_equal_inputs_produce_equal_layouts(
        self,
        tmp_path: Path,
    ) -> None:
        root = tmp_path / "project"
        root.mkdir()
        first = _LayoutResolver(root).resolve_state_layout("task-1")
        second = _LayoutResolver(root).resolve_state_layout("task-1")
        assert first == second

    def test_resolution_creates_no_filesystem_entries(
        self,
        project_root: Path,
    ) -> None:
        resolver = _LayoutResolver(project_root)
        resolver.resolve_state_layout("task-1")
        resolver.resolve_local_artifact_comparison(
            "staging/clip.mp4",
            is_local=True,
        )
        assert list(project_root.iterdir()) == []


class TestBoundariesAndExports:
    def test_no_public_symbols_are_added(self) -> None:
        for name in ("_LayoutResolver", "_StateLayout"):
            assert name not in orchestration_package.__all__
            assert not hasattr(orchestration_package, name)

    def test_layout_module_has_no_mutation_or_provider_imports(self) -> None:
        assert not hasattr(layout_module, "VideoProvider")
        assert not hasattr(layout_module, "_render_instruction_bytes")
        assert not hasattr(layout_module, "_OrchestrationPlanner")

    def test_layout_does_not_import_orchestration_data_models(self) -> None:
        # Lock layout's dependency boundary: layout.py must not depend on the
        # forbidden orchestration data/planning/recovery/execution modules by
        # ANY mechanism — static Import / ImportFrom, __import__, or
        # importlib.import_module (including aliased forms), anywhere in the
        # module (module level, function bodies, class bodies). A dynamic
        # import whose target cannot be proven a safe static string is
        # conservatively rejected. (Since Step G the package __init__ eagerly
        # loads the public facade — and therefore planning/recovery/etc. — so
        # a package-import side-effect check no longer isolates layout; this
        # module-source AST check verifies the same layering guarantee.)
        import ast
        import pathlib

        forbidden_leaves = {
            "_models",
            "recovery",
            "planning",
            "instructions",
            "executor",
            "orchestrator",
        }

        def _leaf_forbidden(name: str | None) -> bool:
            # for relative imports the module carries no package prefix, so
            # a bare leaf ("recovery", "_models", …) is checked directly
            return bool(name) and name.split(".")[-1] in forbidden_leaves

        def _is_forbidden(module: str | None) -> bool:
            if not module:
                return False
            parts = module.split(".")
            return "orchestration" in parts and parts[-1] in forbidden_leaves

        tree = ast.parse(
            pathlib.Path(layout_module.__file__).read_text(encoding="utf-8")
        )

        import_module_names: set[str] = set()  # names bound to import_module

        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    assert not _is_forbidden(alias.name), alias.name
            elif isinstance(node, ast.ImportFrom):
                if node.level >= 1:
                    # relative import from within the orchestration package:
                    # `from . import recovery` / `from .recovery import _x`
                    assert not _leaf_forbidden(node.module), node.module
                    for alias in node.names:
                        assert not _leaf_forbidden(alias.name), alias.name
                else:
                    assert not _is_forbidden(node.module), node.module
                    for alias in node.names:
                        full = (
                            f"{node.module}.{alias.name}" if node.module else alias.name
                        )
                        assert not _is_forbidden(full), full
                if node.module == "importlib":
                    for alias in node.names:
                        if alias.name == "import_module":
                            import_module_names.add(alias.asname or "import_module")

        # every dynamic import must target a statically-provable safe string
        def _reject_dynamic(call: ast.Call) -> None:
            assert call.args, "dynamic import with no static module argument"
            first = call.args[0]
            assert isinstance(first, ast.Constant) and isinstance(first.value, str), (
                "dynamic import with a non-static module argument (cannot prove "
                "it does not load a forbidden module)"
            )
            # a dynamic-import target is forbidden if its leaf name matches —
            # this catches absolute ("...orchestration.recovery"), relative
            # (".recovery", "....recovery"), and bare ("recovery") forms, since
            # relative dotted strings never carry the "orchestration" segment
            assert not _leaf_forbidden(first.value), first.value

        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue
            func = node.func
            if isinstance(func, ast.Name) and (
                func.id == "__import__" or func.id in import_module_names
            ):
                _reject_dynamic(node)
            elif isinstance(func, ast.Attribute) and func.attr == "import_module":
                # importlib.import_module(...) or any <alias>.import_module(...)
                _reject_dynamic(node)
