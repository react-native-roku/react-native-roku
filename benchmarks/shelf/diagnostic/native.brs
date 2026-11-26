sub startShelfFocusProbe()
    m.shelfProbe = CreateObject("roSGNode", "Timer")
    m.shelfProbe.duration = 0.2
    m.shelfProbe.repeat = true
    m.shelfProbe.observeField("fire", "attachShelfFocusProbe")
    m.shelfProbe.control = "start"
end sub

sub attachShelfFocusProbe()
    if m.top.findNode("shelf-23") = invalid then return
    m.shelfProbe.control = "stop"
    m.shelfProbe.unobserveField("fire")
    m.shelfNativeSequence = 0
    for index = 0 to 23
        node = m.top.findNode("shelf-" + index.toStr().trim())
        if node <> invalid
            node.observeFieldScoped("focusedChild", "shelfNativeFocus" + index.toStr().trim())
        end if
    end for
    print "SHELF_NATIVE_READY"
end sub

sub shelfNativeFocus(event as Object)
    node = event.getRoSGNode()
    if node = invalid or not node.hasFocus() then return
    m.shelfNativeSequence = m.shelfNativeSequence + 1
    print "SHELF_NATIVE|" + m.shelfNativeSequence.toStr().trim() + "|" + node.id
end sub
