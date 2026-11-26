sub onFocusSample(event as object)
    target = m.top.focusSampleTarget
    previous = m.top.focusSamplePrevious
    m.top.focusSampleTarget = invalid
    m.top.focusSamplePrevious = invalid
    index = -1
    if target <> invalid and target.hasFocus()
        index = 0
    else if previous <> invalid and previous.hasFocus()
        index = 1
    end if
    m.top.focusSampleReply = FormatJson(event.getData()) + ":" + FormatJson(index)
end sub

sub onExitRequested()
    if m.top.exitRequested
        scene = m.top.getScene()
        if scene <> invalid then scene.exitRequested = true
    end if
end sub

sub init()
    m.top.observeFieldScoped("textEntryRequest", "onTextEntryRequest")
end sub

sub onTextEntryRequest(event as object)
    ' Read this event's payload, not a field that another queued request changed.
    payload = event.getData()
    if payload = "" then return
    m.top.textEntryRequest = ""
    request = ParseJson(payload)
    if type(request) <> "roAssociativeArray" then return
    if request.version <> 2 then return
    if request.revision = invalid then request.revision = 0
    if request.update = true
        if m.textEntryDialog <> invalid
            if m.textEntryId = request.id and m.textEntryClosing = false
                if request.revision > m.textEntryRevision
                    m.textEntryRevision = request.revision
                    m.textEntryText = request.text
                    m.textEntryDialog.text = request.text
                    publishTextEntryCaret()
                end if
                return
            end if
        end if
        if m.textEntryNext <> invalid
            if m.textEntryNext.id = request.id
                if request.revision > m.textEntryNext.revision
                    m.textEntryNext.text = request.text
                    m.textEntryNext.revision = request.revision
                end if
            end if
        end if
        return
    end if
    if request.close = true
        if m.textEntryNext <> invalid
            if m.textEntryNext.id = request.id
                m.textEntryNext = invalid
                publishTextEntryReply(request.id, invalid, false, 0)
                return
            end if
        end if
        if m.textEntryDialog <> invalid
            if m.textEntryId = request.id
                requestTextEntryClose(invalid)
                return
            end if
        end if
        publishTextEntryReply(request.id, invalid, false, 0)
        return
    end if
    if m.textEntryDialog <> invalid
        ' Keep one successor; canceled queued editors never became a native dialog.
        if m.textEntryNext <> invalid then publishTextEntryReply(m.textEntryNext.id, invalid, false, 0)
        m.textEntryNext = request
        requestTextEntryClose(invalid)
        return
    end if
    openTextEntryDialog(request)
end sub

sub openTextEntryDialog(request as object)
    scene = m.top.getScene()
    if scene = invalid
        publishTextEntryReply(request.id, invalid, false, 0)
        return
    end if
    m.textEntryId = request.id
    m.textEntryResult = invalid
    m.textEntryClosing = false
    m.textEntryRevision = 0
    m.textEntrySequence = 0
    m.textEntryObserveChanges = (request.observeChanges = true)
    m.textEntryObserveSelection = (request.observeSelection = true)
    m.textEntryText = request.text
    if request.revision <> invalid then m.textEntryRevision = request.revision
    dialog = CreateObject("roSGNode", "StandardKeyboardDialog")
    dialog.id = "rnr-text-entry-" + FormatJson(request.id)
    dialog.title = request.title
    dialog.keyboardDomain = request.domain
    dialog.buttons = ["OK", "Cancel"]
    dialog.textEditBox.secureMode = request.secure
    dialog.textEditBox.maxTextLength = request.maxLength
    dialog.text = request.text
    dialog.observeFieldScoped("buttonSelected", "onTextEntryButton")
    dialog.observeFieldScoped("wasClosed", "onTextEntryClosed")
    if m.textEntryObserveChanges then dialog.observeFieldScoped("text", "onTextEntryText")
    if m.textEntryObserveSelection
        dialog.textEditBox.observeFieldScoped("cursorPosition", "onTextEntryCaret")
        dialog.textEditBox.observeFieldScoped("text", "onTextEntryCaret")
    end if
    m.textEntryDialog = dialog
    scene.dialog = dialog
    publishTextEntryCaret()
end sub

sub onTextEntryText(event as object)
    if m.textEntryDialog = invalid then return
    if m.textEntryClosing = true then return
    if event.getNode() <> m.textEntryDialog.id then return
    value = event.getData()
    ' Reject queued observations from before a controlled update. Publish only
    ' the currently observed native draft, never a programmatic echo or clear.
    if value <> m.textEntryDialog.text or value = m.textEntryText then return
    m.textEntryText = value
    m.textEntrySequence = m.textEntrySequence + 1
    packet = { version: 2, id: m.textEntryId, draft: true, text: value, revision: m.textEntryRevision, sequence: m.textEntrySequence }
    prefix = textEntryPrefix()
    if prefix <> invalid then packet.prefix = prefix
    m.top.textEntryReply = FormatJson(packet)
end sub

function textEntryPrefix() as dynamic
    if m.textEntryDialog = invalid or m.textEntryClosing = true then return invalid
    if m.textEntryObserveSelection = false then return invalid
    editor = m.textEntryDialog.textEditBox
    text = m.textEntryDialog.text
    if editor.text <> text then return invalid
    cursor = editor.cursorPosition
    if cursor < 0 or cursor > text.Len() then return invalid
    ' Use the native string prefix so JS can compute UTF-16 offsets without
    ' assuming that SceneGraph and JavaScript count characters the same way.
    return text.Left(cursor)
end function

sub publishTextEntryCaret()
    prefix = textEntryPrefix()
    if prefix = invalid then return
    m.textEntrySequence = m.textEntrySequence + 1
    m.top.textEntryReply = FormatJson({ version: 2, id: m.textEntryId, caret: true, text: m.textEntryDialog.text, prefix: prefix, revision: m.textEntryRevision, sequence: m.textEntrySequence })
end sub

sub onTextEntryCaret(event as object)
    if m.textEntryDialog = invalid or m.textEntryClosing = true then return
    editor = m.textEntryDialog.textEditBox
    ' Internal edit boxes need not have an ID. Compare actual native nodes so
    ' a queued event from a retired dialog cannot attach to its successor.
    if not editor.isSameNode(event.getRoSGNode()) then return
    if LCase(event.getField()) = "cursorposition"
        if event.getData() <> editor.cursorPosition then return
    else
        if event.getData() <> editor.text then return
    end if
    publishTextEntryCaret()
end sub

sub onTextEntryButton(event as object)
    if m.textEntryDialog = invalid then return
    if event.getNode() <> m.textEntryDialog.id then return
    value = invalid
    if event.getData() = 0 then value = m.textEntryDialog.text
    requestTextEntryClose(value)
end sub

sub requestTextEntryClose(value)
    if m.textEntryDialog = invalid then return
    if m.textEntryClosing = true then return
    m.textEntryClosing = true
    m.textEntryResult = value
    m.textEntryText = ""
    m.textEntryDialog.text = ""
    ' Keep the scoped close observer until native dismissal is acknowledged.
    m.textEntryDialog.close = true
end sub

sub onTextEntryClosed(event as object)
    if m.textEntryDialog = invalid then return
    if event.getNode() <> m.textEntryDialog.id then return
    dialog = m.textEntryDialog
    id = m.textEntryId
    value = m.textEntryResult
    revision = m.textEntryRevision
    m.textEntryDialog = invalid
    m.textEntryId = invalid
    m.textEntryResult = invalid
    m.textEntryText = ""
    m.textEntryClosing = false
    dialog.unobserveFieldScoped("buttonSelected")
    dialog.unobserveFieldScoped("wasClosed")
    dialog.unobserveFieldScoped("text")
    dialog.textEditBox.unobserveFieldScoped("cursorPosition")
    dialog.textEditBox.unobserveFieldScoped("text")
    dialog.text = ""
    ' Only this actual wasClosed observation may assert closed=true.
    publishTextEntryReply(id, value, true, revision)
    nextRequest = m.textEntryNext
    m.textEntryNext = invalid
    if nextRequest <> invalid then openTextEntryDialog(nextRequest)
end sub

sub publishTextEntryReply(id, value, observed as boolean, revision)
    m.top.textEntryReply = FormatJson({ version: 2, id: id, text: value, closed: observed, revision: revision })
end sub
