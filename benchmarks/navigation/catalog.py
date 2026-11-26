"""Independent expected state for the frozen, full-title 24-card catalog."""

import re
import xml.etree.ElementTree as ET

REST = 0x1C2A38FF
ACTIVE = 0x87CEFAFF


def require(condition, message):
    if not condition:
        raise ValueError(message)


def title(card):
    label = f"Selected Card {card + 1}"
    if card % 3:
        label += " · " + ("A feature-length selection with an extended catalog description. " * 3).strip()
    return label


def step(origin, key):
    row, column = divmod(origin, 8)
    dy, dx = {"Up": (-1, 0), "Down": (1, 0), "Left": (0, -1), "Right": (0, 1)}[key]
    return max(0, min(2, row + dy)) * 8 + max(0, min(7, column + dx))


def offset_for(card, offset):
    top = (card // 8) * 112
    return max(0, min(124, max(top + 92 - 212, min(top, offset))))


def expected(card, offset):
    lines = 3 if card % 3 else 1
    return {"focus": card, "text": title(card), "width": 1050, "height": 39 * lines,
            "lines": lines, "offset": offset,
            **{f"color{i}": ACTIVE if i == card else REST for i in range(24)}}


def native_snapshot(xml):
    """Read externally observable fields only. Missing evidence remains missing."""
    root = ET.fromstring(xml)
    plugins = root.findall(".//topscreen/plugin")
    require(len(plugins) == 1 and plugins[0].get("id") == "dev", "unexpected foreground tree")
    nodes = {n.get("name"): n for n in root.iter() if n.get("name")}
    label = nodes["selection"]
    bounds = [float(v) for v in re.findall(r"-?[\d.]+", label.get("bounds", ""))]
    require(len(bounds) == 4, "missing title bounds")
    scroll = list(nodes["catalog-window"])[0]
    translation = [float(v) for v in re.findall(r"-?[\d.]+", scroll.get("translation", "{0, 0}"))]
    text = label.get("text", "")
    state = {"text": " ".join(text.split()), "width": bounds[2], "height": bounds[3],
             "offset": -translation[1], "ellipsized": label.get("isTextEllipsized") == "true"}
    focused = []
    for i in range(24):
        card = nodes[f"shelf-{i}"]
        if card.get("focused") == "true" and card.get("focusable") == "true":
            focused.append(i)
        color = list(card)[0].get("color")
        if color:
            state[f"color{i}"] = int(color.lstrip("#"), 16)
    if len(focused) == 1:
        state["focus"] = focused[0]
    return state


def verify_snapshot(state, card, offset):
    wanted = expected(card, offset)
    # SceneGraph app-ui omits numLines in some builds. The observer supplies it.
    return not state.get("ellipsized") and all(state.get(k) == v for k, v in wanted.items() if k != "lines")


def validate_replay(replay):
    require(replay.get("pass") is True, replay.get("error") or "replay failed")
    commands = replay["commands"]
    require(len(commands) >= 2 and commands[-1]["key"] == "Select", "missing final Select")
    require(all(not c.get("error") for c in commands), "input transport failure")
    card, offset = replay["origin"], replay["originOffset"]
    wanted = []
    for c in commands[:-1]:
        dest = step(card, c["key"])
        require(dest != card, "scored burst contains a stationary input")
        card, offset = dest, offset_for(dest, offset)
        wanted.append((card, offset))
    require(wanted == list(zip(replay["intendedOrder"], replay["intendedOffsets"])),
            "replay expectations disagree with the catalog")
    require(replay["activatedTitle"] == "Details for " + title(card).split(" · ")[0],
            "wrong activated card")
    require(replay["restoredOffset"] == offset, "wrong restored offset")
    observations = replay["observations"]
    require(verify_snapshot(native_snapshot(observations[-1]["xml"]), card, offset),
            "restored focus, title, color or scroll state disagrees with the catalog")
    detail = "Details for " + title(card).split(" · ")[0]
    detail_trees = [ET.fromstring(o["xml"]) for o in observations if o["tag"].startswith("Detail")]
    def opened(tree):
        return (tree.find(".//topscreen/plugin[@id='dev']") is not None
                and any(n.get("name") == "details" and n.get("text") == detail for n in tree.iter())
                and any(n.get("name") == "back-to-catalog" and n.get("focused") == "true"
                        for n in tree.iter()))
    require(any(opened(tree) for tree in detail_trees), "correct activated Detail was not observed")
    require(not any(n.get("name") == "details" for n in ET.fromstring(observations[-1]["xml"]).iter()),
            "Detail still present after Back")
    origin = replay["origin"]
    seed = next(native_snapshot(o["xml"]) for o in reversed(observations)
                if o["tag"] == f"settled Card {origin + 1}" and verify_snapshot(
                    native_snapshot(o["xml"]), origin, replay["originOffset"]))
    return wanted, seed


def verify_burst_route(replay):
    recipes = {
        "reversal": (16, 104, ["Right"] * 7 + ["Left"] * 4),
        "scrolling": (8, 0, ["Right", "Down", "Right", "Up", "Left", "Up",
                            "Right", "Down", "Right", "Down", "Up"]),
    }
    origin, offset, directions = recipes[replay["route"]]
    require((replay["origin"], replay["originOffset"]) == (origin, offset),
            "wrong starting card or offset for this route")
    require([c["key"] for c in replay["commands"]] == directions + ["Select"],
            "incomplete or different burst route")
