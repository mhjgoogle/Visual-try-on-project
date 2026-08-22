"""ADR-0071 —— 参考输入从「按角色写死的槽位」改为有序集合（TASK-097 批次 2）。

守的是**跨层合同**：目录声明能力、Provider 不猜、能力不足时拒绝而不是截断。
JS 那边的行为测试在 ``mockups/motv-workspace/tests/chainmech.test.mjs``（批次 0
已打硬）与 ``refsetwire.test.mjs``（本批的接线）。

这里的断言刻意**派生**：从源码读出清单再比对，不写死数字，也不写死
「记得改这几处」的列表（TASK-097 §2.6.1 / §2.6.3）。
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from ai_video_workflow.app.paid_coordinator import reference_capability_violation
from ai_video_workflow.config.catalog import (
    NO_REFERENCE_IMAGES,
    CatalogConfigError,
    ReferenceImageCapability,
    parse_catalog,
)
from ai_video_workflow.providers.errors import InvalidProviderRequestError
from ai_video_workflow.providers.models import (
    ProviderRequest,
    ReferenceImage,
    validate_public_media_url,
    validate_reference_images,
)

_REPO = Path(__file__).resolve().parents[2]


def _catalog(model_extra: dict | None = None) -> dict:
    """A minimal VALID catalog, built from the shipped one's shape.

    Derived from the real file rather than hand-written (2.6.3 rule 2: a
    hand-written fixture invents fields, and then the guard validates a world the
    product does not have).
    """
    raw = json.loads(
        (_REPO / "config" / "providers" / "wfm1-default.json").read_text("utf-8")
    )
    if model_extra is not None:
        raw["providers"]["cloud-a"]["models"]["std-6s"]["reference_images"] = (
            model_extra
        )
    return raw


def _image(ordinal: int = 1, role: str = "character-reference") -> ReferenceImage:
    return ReferenceImage(
        ordinal=ordinal,
        url_or_data="https://example.invalid/a.png",
        role=role,
        asset_id=f"img-{ordinal}",
        version=3,
        content_digest="sha256:aaa",
    )


# --- decision 4: the catalog declares, and silence means none ----------------


def test_a_model_that_declares_nothing_takes_no_reference_images() -> None:
    """The shipped catalog declares nothing, so every model reads as max 0."""
    catalog = parse_catalog(_catalog())
    for provider in catalog.providers.values():
        for model in provider.models.values():
            assert model.reference_images == NO_REFERENCE_IMAGES
            assert model.reference_images.accepts_reference_images is False


def test_a_declaration_is_parsed_and_an_impossible_one_is_refused() -> None:
    catalog = parse_catalog(
        _catalog({"max": 3, "addressable": True, "roles": ["character-reference"]})
    )
    cap = catalog.providers["cloud-a"].models["std-6s"].reference_images
    assert cap == ReferenceImageCapability(
        max_images=3,
        addressable=True,
        roles=("character-reference",),
        declared=True,
    )
    # `declared` separates "the catalog said none" from "the catalog said nothing".
    # A model that resolved but declared nothing is UNDECLARED -- the studio prints a
    # different sentence for each, and claiming the wrong one is a lie about what the
    # catalog states (codex round 1).
    silent = parse_catalog(_catalog()).providers["cloud-b"].models["ray-flash"]
    assert silent.reference_images.declared is False
    assert silent.reference_images.max_images == 0

    # max 0 + addressable is a catalog that contradicts itself: a prompt cannot
    # point at an image the model is never given. Refused at LOAD, so the
    # contradiction never reaches a decision.
    with pytest.raises(CatalogConfigError, match="addressable requires max"):
        parse_catalog(_catalog({"max": 0, "addressable": True, "roles": []}))
    with pytest.raises(CatalogConfigError, match="roles are meaningless"):
        parse_catalog(_catalog({"max": 0, "addressable": False, "roles": ["x"]}))
    # a bool is a bool; the string "true" is not
    with pytest.raises(CatalogConfigError, match="expected a JSON boolean"):
        parse_catalog(_catalog({"max": 1, "addressable": "true", "roles": []}))


def test_an_unknown_key_in_the_declaration_is_still_refused() -> None:
    """Optional does not mean loose: the closed-key rule still applies inside."""
    with pytest.raises(CatalogConfigError, match="unknown keys"):
        parse_catalog(
            _catalog({"max": 1, "addressable": False, "roles": [], "oops": 1})
        )


def test_an_explicit_null_declaration_is_malformed_not_a_default() -> None:
    """Absent vs explicit null (codex round 2, P2).

    A catalog is version-controlled and reviewed, so a ``null`` there is a mistake
    somebody should be told about -- not a quiet way to disable the capability.
    """
    raw = json.loads(
        (_REPO / "config" / "providers" / "wfm1-default.json").read_text("utf-8")
    )
    raw["providers"]["cloud-a"]["models"]["std-6s"]["reference_images"] = None
    with pytest.raises(CatalogConfigError, match="reference_images"):
        parse_catalog(raw)


# --- decision 1: the ordered set, checked at the provider boundary -----------


def test_ordinals_must_be_exactly_one_to_n() -> None:
    assert validate_reference_images(None) == ()
    assert len(validate_reference_images([_image(1), _image(2)])) == 2
    # a HOLE makes every later marker name a different picture
    with pytest.raises(InvalidProviderRequestError, match="1..N"):
        validate_reference_images([_image(1), _image(3)])
    # a REPEAT makes one number ambiguous
    with pytest.raises(InvalidProviderRequestError, match="1..N"):
        validate_reference_images([_image(1), _image(1)])
    # out of order is the same defect wearing a different hat
    with pytest.raises(InvalidProviderRequestError, match="1..N"):
        validate_reference_images([_image(2), _image(1)])


def test_every_entry_binds_a_version_and_a_digest() -> None:
    """ADR-0041's existing discipline: a same-parameter re-run needs the version."""
    with pytest.raises(InvalidProviderRequestError, match="version"):
        ReferenceImage(
            ordinal=1,
            url_or_data="https://example.invalid/a.png",
            role="character-reference",
            asset_id="img-1",
            version=0,
            content_digest="sha256:aaa",
        )
    with pytest.raises(InvalidProviderRequestError, match="content_digest"):
        ReferenceImage(
            ordinal=1,
            url_or_data="https://example.invalid/a.png",
            role="character-reference",
            asset_id="img-1",
            version=1,
            content_digest="   ",
        )


def test_a_reference_image_is_never_a_local_path() -> None:
    """Same rule as first_frame_image: a path could exfiltrate a local file."""
    with pytest.raises(InvalidProviderRequestError, match="local paths"):
        ReferenceImage(
            ordinal=1,
            url_or_data="/etc/passwd",
            role="character-reference",
            asset_id="img-1",
            version=1,
            content_digest="sha256:aaa",
        )


def test_a_media_url_must_really_be_public_not_merely_http() -> None:
    """The message always said "public"; now the check does too (codex round 2).

    The PROVIDER dereferences these URLs, so a loopback or private address asks a
    cloud service to fetch something on its own network. Both the reference set and
    the pre-existing first-frame field share one implementation, because fixing only
    the new field would leave the identical hole on the field in use today.
    """
    ok = (
        "https://cdn.example.com/a.png",
        # a genuinely routable literal. NOT a 203.0.113.x documentation address:
        # Python 3.12+ reports RFC 5737 ranges as non-global, and refusing them is
        # correct (they are not routable either) -- that was the test's mistake,
        # not the validator's.
        "http://8.8.8.8/a.png",
        "data:image/png;base64,AAAA",
    )
    for value in ok:
        assert validate_public_media_url(value, field_name="f") == value

    refused = (
        "http://localhost/a.png",
        "http://LOCALHOST:8080/a.png",
        "http://box.localhost/a.png",
        "http://printer.local/a.png",
        "http://127.0.0.1/a.png",
        "http://[::1]/a.png",
        "http://10.0.0.5/a.png",
        "http://192.168.1.1/a.png",
        "http://169.254.169.254/latest/meta-data/",
        "http://0.0.0.0/a.png",
        # CGNAT: neither private nor reserved, and still not public. An enumeration
        # of ranges missed it; `is_global` is the property actually being asked
        # about, and keeping it current is the stdlib's job (codex round 6, P1).
        "http://100.64.0.1/a.png",
        "https://user:pw@cdn.example.com/a.png",
        "https:///a.png",
        "file:///etc/passwd",
        "/etc/passwd",
    )
    for value in refused:
        with pytest.raises(InvalidProviderRequestError):
            validate_public_media_url(value, field_name="f")

    # …and the reference image itself refuses the same set
    with pytest.raises(InvalidProviderRequestError, match="not a globally routable"):
        ReferenceImage(
            ordinal=1,
            url_or_data="http://169.254.169.254/latest/meta-data/",
            role="character-reference",
            asset_id="img-1",
            version=1,
            content_digest="sha256:aaa",
        )
    # A DNS NAME IS NOT RESOLVED, deliberately (see the docstring): the fetch happens
    # on the provider's host with the provider's resolver, and a name can re-resolve
    # between our check and their fetch. Raised and declined in codex rounds 3, 5 and
    # 7; the boundary that can actually enforce it is the fetcher's egress policy.
    assert validate_public_media_url("https://who-knows.example/a.png", field_name="f")

    # A MALFORMED URL IS REFUSED, NOT RAISED THROUGH (codex round 7, P2): `urlsplit`
    # itself throws on an unterminated bracketed host, and an unhandled ValueError
    # would surface as a crash where a validation refusal belongs.
    for malformed in ("https://[::1", "http://[", "https://[::1]:notaport/a.png"):
        with pytest.raises(InvalidProviderRequestError):
            validate_public_media_url(malformed, field_name="f")


def test_a_literal_address_is_refused_in_every_notation() -> None:
    """127.0.0.1 has more than one spelling, and resolvers accept them all.

    Round 2 claimed "literal addresses are checked" while only reading the canonical
    forms, so ``http://2130706433/`` -- the decimal integer form of loopback -- fell
    through the "must be a DNS name" branch untouched (codex round 3, P1).
    """
    disguises = (
        "http://2130706433/a.png",  # 127.0.0.1 in decimal
        "http://0x7f000001/a.png",  # ...in hex
        "http://017700000001/a.png",  # ...in octal
        "http://0x7f.0.0.1/a.png",  # ...dotted hex (codex round 4)
        "http://0x7f.0x0.0x0.0x1/a.png",  # ...every octet in hex (codex round 5)
        "http://127.1/a.png",  # ...short form
        "http://3232235777/a.png",  # 192.168.1.1 in decimal
        "http://999999999999999/a.png",  # not an address, not a name either
        "http://intranet/a.png",  # a single label is never a public name
        "http://localhost./a.png",  # the root dot does not make it public
        "http://foo.localhost./a.png",  # ...nor here (codex round 5)
        "http://printer.local/a.png",
    )
    for value in disguises:
        with pytest.raises(InvalidProviderRequestError):
            validate_public_media_url(value, field_name="f")

    # ...while real names keep working. THIS HALF MATTERS AS MUCH: an earlier draft of
    # the check refused any final label that parses as hex, which would have rejected
    # example.ca and example.de -- many ccTLDs are pure a-f letters. A guard that
    # blocks legitimate domains gets worked around, and then protects nothing.
    for value in (
        "https://cdn.example.com/a.png",
        "https://example.ca/a.png",
        "https://example.de/a.png",
        "https://xn--fsq.com/a.png",
        "https://a-b.example.co.uk/a.png",
        # an INTERNATIONALISED host must keep working (codex round 5, P2): an earlier
        # draft required ASCII, which silently broke public URLs that used to work.
        "https://例え.jp/a.png",
    ):
        assert validate_public_media_url(value, field_name="f") == value


def test_inline_reference_data_is_bounded_per_image_and_per_set() -> None:
    """N images each under the cap can still be a payload nobody wants to store."""
    from ai_video_workflow.providers.models import (
        MAX_INLINE_IMAGE_LEN,
        MAX_INLINE_IMAGE_SET_LEN,
    )

    def _img(ordinal: int, url: str) -> ReferenceImage:
        return ReferenceImage(
            ordinal=ordinal,
            url_or_data=url,
            role="character-reference",
            asset_id=f"img-{ordinal}",
            version=1,
            content_digest="sha256:aaa",
        )

    with pytest.raises(InvalidProviderRequestError, match="too large"):
        _img(1, "data:image/png;base64," + "A" * (MAX_INLINE_IMAGE_LEN + 1))

    # each under the per-image cap, together over the SET cap
    chunk = "data:image/png;base64," + "A" * (MAX_INLINE_IMAGE_LEN - 100)
    many = [_img(i + 1, chunk) for i in range(4)]
    with pytest.raises(InvalidProviderRequestError, match="ceiling for one request"):
        validate_reference_images(many)
    assert len(validate_reference_images(many[:2])) == 2
    assert MAX_INLINE_IMAGE_SET_LEN > MAX_INLINE_IMAGE_LEN


def test_an_absurdly_long_ordinal_is_classified_not_crashed() -> None:
    """Python 3.11+ raises on a str->int over 4300 digits (codex round 3, P2).

    So the marker had to be classified WITHOUT converting it: an ordinal that long
    cannot name a bound image anyway, and a crash where SPEC_INVALID belongs is a
    coordinator failure the caller cannot act on.
    """
    addressable = ReferenceImageCapability(
        max_images=3, addressable=True, roles=(), declared=True
    )
    prompt = "look at [[ref:" + "9" * 5000 + "]]"
    why = reference_capability_violation(
        addressable, (_image(1),), prompt, model_id="m"
    )
    assert why is not None and "absurdly long" in why


def test_the_first_frame_validators_share_that_one_implementation() -> None:
    """Two boundaries, one rule -- not a second, weaker copy."""
    from ai_video_workflow.app import paid_coordinator
    from ai_video_workflow.providers import cloud_minimax

    CoordinatorError = paid_coordinator.CoordinatorError
    coordinator_validate = paid_coordinator._validate_first_frame_image
    provider_validate = cloud_minimax._validate_first_frame_image

    assert provider_validate("https://cdn.example.com/a.png")
    assert coordinator_validate("https://cdn.example.com/a.png")
    with pytest.raises(InvalidProviderRequestError):
        provider_validate("http://127.0.0.1/a.png")
    with pytest.raises(CoordinatorError):
        coordinator_validate("http://127.0.0.1/a.png")
    # the data-URL size ceiling each boundary owns is still enforced
    with pytest.raises(InvalidProviderRequestError, match="too large"):
        provider_validate("data:image/png;base64," + "A" * (9 * 1024 * 1024))


def test_provider_request_is_additive_and_round_trips() -> None:
    base = dict(
        provider_id="cloud-a",
        task_id="task-1",
        shot_id="shot-1",
        prompt="p",
        duration_seconds=6.0,
        width=1280,
        height=720,
        frame_rate=24.0,
    )
    # ADDITIVE: an existing caller passes nothing and gets the empty set
    assert ProviderRequest(**base).reference_images == ()
    request = ProviderRequest(**base, reference_images=[_image(1)])
    assert request.to_json_dict()["reference_images"] == [
        {
            "ordinal": 1,
            "url_or_data": "https://example.invalid/a.png",
            "role": "character-reference",
            "asset_id": "img-1",
            "version": 3,
            "content_digest": "sha256:aaa",
        }
    ]


def test_the_wal_round_trip_tells_absent_from_malformed() -> None:
    """A recovered job that silently lost its images is not the same job.

    ABSENT means a snapshot written before ADR-0071, and the empty set is the truth
    for it. PRESENT-BUT-NULL is malformed data, and treating it as absent was the
    same "silently fewer images" defect one layer down (codex round 1, P2).
    """
    from ai_video_workflow.orchestration import recovery

    base = dict(
        provider_id="cloud-a",
        task_id="task-1",
        shot_id="shot-1",
        prompt="p",
        duration_seconds=6.0,
        width=1280,
        height=720,
        frame_rate=24.0,
    )
    request = ProviderRequest(**base, reference_images=[_image(1), _image(2)])
    snapshot = recovery._snapshot_provider_request(request)
    restored = recovery._restore_provider_request(snapshot)
    assert restored.reference_images == request.reference_images

    # a pre-ADR snapshot: the key is simply not there
    legacy = json.loads(json.dumps(recovery._thaw_mapping(snapshot["payload"])))
    legacy.pop("reference_images")
    assert recovery._restore_reference_images(recovery._ABSENT, name="x") == ()
    assert "reference_images" not in legacy

    # present-but-null is refused, not silently emptied
    with pytest.raises(Exception, match="expected a sequence"):
        recovery._restore_reference_images(None, name="x")


# --- decision 5 / option C: refuse, never truncate ---------------------------


def test_capability_violations_refuse_rather_than_drop_images() -> None:
    none = NO_REFERENCE_IMAGES
    three = ReferenceImageCapability(max_images=3, addressable=False, roles=())
    addressable = ReferenceImageCapability(max_images=3, addressable=True, roles=())
    role_limited = ReferenceImageCapability(
        max_images=3, addressable=True, roles=("character-reference",)
    )
    images = (_image(1), _image(2))

    # no images bound -> nothing to say, on ANY capability
    assert reference_capability_violation(none, (), "p", model_id="m") is None

    # option C: not declared -> refused, and the message says why we do not degrade
    why = reference_capability_violation(none, images, "p", model_id="m")
    assert why is not None
    assert "Option C" in why and "silently sending fewer" in why

    assert reference_capability_violation(three, images, "p", model_id="m") is None

    # over the declared max -> refused, naming the counts; NOT truncated
    over = tuple(_image(i + 1) for i in range(4))
    why = reference_capability_violation(three, over, "p", model_id="m")
    assert why is not None and "not truncated" in why

    # a prompt that points at an ordinal on a model that cannot resolve one
    why = reference_capability_violation(
        three, images, "look at [[ref:1]]", model_id="m"
    )
    assert why is not None and "ordinal" in why
    assert (
        reference_capability_violation(
            addressable, images, "look at [[ref:1]]", model_id="m"
        )
        is None
    )

    # a role the model does not accept
    why = reference_capability_violation(
        role_limited, (_image(1, role="prop-reference"),), "p", model_id="m"
    )
    assert why is not None and "prop-reference" in why


def test_a_marker_must_name_an_image_that_is_actually_bound() -> None:
    """An addressable model is not a licence to point at nothing (codex round 1).

    Checking only that markers EXIST let ``[[ref:0]]`` and ``[[ref:99]]`` reach a paid
    generation. This is the last stop before money, so a caller that bypassed the
    studio must not get further than one that did not.
    """
    addressable = ReferenceImageCapability(
        max_images=3, addressable=True, roles=(), declared=True
    )
    images = (_image(1), _image(2))

    assert (
        reference_capability_violation(
            addressable, images, "a [[ref:1]] b [[ref:2]]", model_id="m"
        )
        is None
    )
    for prompt, needle in (
        ("look at [[ref:0]]", "[[ref:0]]"),
        ("look at [[ref:3]]", "[[ref:3]]"),
        ("look at [[ref:99]]", "[[ref:99]]"),
    ):
        why = reference_capability_violation(addressable, images, prompt, model_id="m")
        assert why is not None, f"{prompt!r} must be refused"
        assert needle in why
        assert "resolve to nothing" in why
    # every dangling ordinal is named, not just the first one
    why = reference_capability_violation(
        addressable, images, "[[ref:7]] and [[ref:9]]", model_id="m"
    )
    assert why is not None and "[[ref:7]]" in why and "[[ref:9]]" in why

    # ZERO BOUND IMAGES IS THE CASE WHERE EVERY MARKER DANGLES (codex round 2, P1).
    # An early `if not images: return None` skipped straight past this, so a prompt
    # naming [[ref:1]] with an empty set could launch a paid generation.
    why = reference_capability_violation(
        addressable, (), "look at [[ref:1]]", model_id="m"
    )
    assert why is not None, "a marker with no images bound must be refused"
    assert "resolve to nothing" in why
    # …and a prompt with no markers and no images is still fine
    assert (
        reference_capability_violation(addressable, (), "plain", model_id="m") is None
    )


def test_the_refusal_happens_before_the_reservation() -> None:
    """A refusal after a hold is a refund problem; before it, it is an answer."""
    src = (
        _REPO / "src" / "ai_video_workflow" / "app" / "paid_coordinator.py"
    ).read_text("utf-8")
    gate = src.index("violation = reference_capability_violation(")
    lock = src.index("with account_budget_lock(")
    assert gate < lock, (
        "the reference-capability gate must run BEFORE the reservation lock"
    )


def test_minimax_refuses_a_request_carrying_reference_images() -> None:
    """The boundary that builds the body stops it too, independently."""
    src = (
        _REPO / "src" / "ai_video_workflow" / "providers" / "cloud_minimax.py"
    ).read_text("utf-8")
    payload = src.split("def _payload", 1)[1].split("\n    @staticmethod", 1)[0]
    assert "request.reference_images" in payload
    assert "refusing rather" in payload, (
        "dropping the images silently is the defect; the refusal must be explicit"
    )


# --- decision 2: one marker syntax, both languages ---------------------------


def test_the_marker_syntax_is_the_same_on_both_sides() -> None:
    """The marker is [[ref:N]], and the two languages must agree on it.

    A drift here is invisible until a prompt compiled by the studio is validated by
    the backend and one of them does not see the marker at all.
    """
    py = (
        _REPO / "src" / "ai_video_workflow" / "app" / "paid_coordinator.py"
    ).read_text("utf-8")
    js = (
        _REPO / "mockups" / "motv-workspace" / "src" / "workflow" / "refset.js"
    ).read_text("utf-8")
    py_pattern = re.search(r"_REF_MARKER_RE = re\.compile\(r\"([^\"]+)\"\)", py)
    js_pattern = re.search(r"const MARKER_RE = /([^/]+)/g;", js)
    assert py_pattern and js_pattern
    assert py_pattern.group(1) == js_pattern.group(1), (
        "the [[ref:N]] pattern must be identical in both languages"
    )
    # BEHAVIOUR, NOT TEXT. An earlier version of this test asserted the string
    # "{{Image" appeared nowhere -- and failed on the COMMENT that explains why the
    # ADR did not borrow that spelling. Grepping for a spelling cannot tell a
    # rejected idea from a used one; compiling the pattern can.
    compiled = re.compile(py_pattern.group(1))
    assert compiled.findall("look at [[ref:1]] and [[ref:12]]") == ["1", "12"]
    assert compiled.search("{{Image 1}}") is None, (
        "the borrowed mechanism must not also match the spelling it replaced"
    )
    # ASCII DIGITS ONLY (codex round 4, P2). Python's `\d` matches every Unicode
    # decimal digit and JavaScript's does not, so `\d` made one prompt mean two
    # different things depending on which layer read it.
    assert r"\d" not in py_pattern.group(1), "use [0-9]; Python's \\d is Unicode-wide"
    assert compiled.search("[[ref:٣]]") is None, (
        "an Arabic-Indic digit must not be a marker on one side only"
    )
