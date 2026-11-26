sub onRequest()
    if m.task = invalid
        m.task = CreateObject("roSGNode", "RNRDeviceFactsTask")
        m.task.observeField("reply", "onReply")
        m.task.observeField("event", "onEvent")
        m.task.command = m.top.request
        m.task.control = "RUN"
    else
        m.task.command = m.top.request
    end if
end sub

sub onReply()
    m.top.reply = m.task.reply
end sub

sub onEvent()
    m.top.event = m.task.event
end sub
