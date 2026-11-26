sub startDeepProbe()
    m.deepTimer = CreateObject("roSGNode", "Timer")
    m.deepTimer.duration = 0.05
    m.deepTimer.repeat = true
    m.deepTimer.observeFieldScoped("fire", "attachDeepProbe")
    m.deepTimer.control = "start"
    m.deepSequence = 0
end sub

sub attachDeepProbe()
    grid = m.top.findNode("catalog-grid")
    position = m.top.findNode("catalog-position")
    if grid = invalid or position = invalid or grid.getChildCount() <> 2 then return
    content = grid.getChild(0)
    indicator = grid.getChild(1)
    if content.getChildCount() < 3 then return
    spacer = content.getChild(content.getChildCount() - 1)
    if spacer.getChildCount() <> 0 then return
    if not content.hasField("translation") or not indicator.hasField("opacity") then return
    m.deepGrid = grid
    m.deepPosition = position
    m.deepContent = content
    m.deepIndicator = indicator
    m.deepSpacer = spacer
    content.observeFieldScoped("translation", "probeDeepScroll")
    indicator.observeFieldScoped("opacity", "probeDeepIndicator")
    spacer.observeFieldScoped("translation", "probeDeepSpacer")
    m.deepTimer.control = "stop"
    m.deepTimer.unobserveFieldScoped("fire")
    print "RNR_DEEP_READY"
end sub

sub reportDeepProbe(kind as String)
    offset = -m.deepContent.translation[1]
    observed = { focus: [], rows: [], visible: [], offset: offset, spacer: m.deepSpacer.translation[1], indicator: m.deepIndicator.opacity, position: m.deepPosition.text, clip: m.deepGrid.clippingRect }
    for index = 0 to m.deepContent.getChildCount() - 1
        slot = m.deepContent.getChild(index)
        if slot.getChildCount() <> 1 then continue for
        row = slot.getChild(0)
        if row.getChildCount() <> 4 then continue for
        first = row.getChild(0)
        if left(first.id, 13) <> "catalog-card-" then continue for
        rowIndex = int(val(mid(first.id, 14)) / 4)
        observed.rows.push(rowIndex)
        if rowIndex * 200 >= offset + 680 or rowIndex * 200 + 188 <= offset then continue for
        observed.visible.push(rowIndex)
        for col = 0 to 3
            card = row.getChild(col)
            if not card.hasFocus() then continue for
            observed.focus.push(val(mid(card.id, 14)))
            observed.color = card.getChild(0).color
            observed.title = card.getChild(2).text
        end for
    end for
    m.deepSequence = m.deepSequence + 1
    print "RNR_DEEP_FIELD|" + FormatJson({ seq: m.deepSequence, kind: kind, value: observed, index: -1 })
end sub

sub probeDeepScroll(event as Object)
    reportDeepProbe("scroll")
end sub

sub probeDeepIndicator(event as Object)
    reportDeepProbe("indicator")
end sub

sub probeDeepSpacer(event as Object)
    reportDeepProbe("spacer")
end sub
