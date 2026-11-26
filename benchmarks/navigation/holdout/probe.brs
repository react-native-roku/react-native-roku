sub startHoldoutProbe()
    m.holdoutProbe = CreateObject("roSGNode", "Timer")
    m.holdoutProbe.duration = 0.06
    m.holdoutProbe.repeat = true
    m.holdoutProbe.observeFieldScoped("fire", "attachHoldoutProbe")
    m.holdoutProbe.control = "start"
    m.holdoutSeen = {}
    m.holdoutSequence = 0
end sub

sub attachHoldoutProbe()
    window = m.top.findNode("holdout-window")
    if window = invalid or window.getChildCount() = 0 then return
    if m.holdoutContent = invalid
        m.holdoutContent = window.getChild(0)
        m.holdoutContent.observeFieldScoped("translation", "probeHoldoutScroll")
        print "RNR_HOLDOUT_READY"
    end if
    for index = 1 to 8
        id = "route-" + index.toStr().trim()
        if m.holdoutSeen.doesExist(id) then continue for
        row = m.top.findNode(id)
        if row = invalid or row.getChildCount() <> 3 then continue for
        solidOrReactPaint = row.getChild(0)
        if not solidOrReactPaint.hasField("color") then continue for
        row.observeFieldScoped("focusedChild", "probeHoldoutFocus")
        solidOrReactPaint.observeFieldScoped("color", "probeHoldoutColor")
        m.holdoutSeen[id] = true
    end for
    if m.holdoutSeen.count() = 8
        m.holdoutProbe.control = "stop"
        m.holdoutProbe.unobserveFieldScoped("fire")
    end if
end sub

sub reportHoldoutProbe(kind as String)
    observed = { focus: 0, rows: {}, offset: -m.holdoutContent.translation[1] }
    for index = 0 to m.holdoutContent.getChildCount() - 1
        slot = m.holdoutContent.getChild(index)
        row = slot
        if left(row.id, 6) <> "route-"
            if slot.getChildCount() <> 1 then continue for
            row = slot.getChild(0)
        end if
        if left(row.id, 6) <> "route-" or row.getChildCount() <> 3 then continue for
        paint = row.getChild(0)
        if not paint.hasField("color") then continue for
        poster = row.getChild(1)
        if not poster.hasField("uri")
            if poster.getChildCount() <> 1 then continue for
            poster = poster.getChild(0)
        end if
        if not poster.hasField("uri") then continue for
        caption = row.getChild(2)
        if not caption.hasField("text") then continue for
        if row.hasFocus() then observed.focus = val(mid(row.id, 7))
        y = slot.translation[1]
        if left(slot.id, 6) <> "route-" then y = y + row.translation[1]
        observed.rows[row.id] = {
            y: y
            color: paint.color
            title: caption.text
            titleWidth: caption.width
            poster: poster.uri
            posterWidth: poster.width
            posterHeight: poster.height
        }
    end for
    m.holdoutSequence = m.holdoutSequence + 1
    print "RNR_HOLDOUT_FIELD|" + FormatJson({ seq: m.holdoutSequence, kind: kind, value: observed, index: -1 })
end sub

sub probeHoldoutFocus(event as Object)
    reportHoldoutProbe("focus")
end sub

sub probeHoldoutColor(event as Object)
    reportHoldoutProbe("color")
end sub

sub probeHoldoutScroll(event as Object)
    reportHoldoutProbe("scroll")
end sub
