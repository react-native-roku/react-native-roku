sub init()
    m.top.functionName = "runDeviceFacts"
end sub

sub runDeviceFacts()
    m.device = CreateObject("roDeviceInfo")
    m.routeEpoch = 0
    port = CreateObject("roMessagePort")
    m.device.setMessagePort(port)
    m.device.enableCodecCapChangedEvent(true)
    m.device.enableAudioGuideChangedEvent(true)
    m.device.enableAppFocusEvent(true)
    m.device.enableLowGeneralMemoryEvent(true)
    m.top.observeField("command", port)
    m.top.event = FormatJson({ type: "system", snapshot: { screenReader: m.device.isAudioGuideEnabled() } })
    command = m.top.command
    while true
        if command <> ""
            request = ParseJson(command)
            if type(request) = "roAssociativeArray"
                if request.type = "dispose" then exit while
                reply = probeDeviceFacts(request)
                reply.id = request.id
                m.top.reply = FormatJson(reply)
            end if
        end if
        command = ""
        message = wait(0, port)
        if type(message) = "roSGNodeEvent"
            command = message.getData()
        else if type(message) = "roDeviceInfoEvent"
            info = message.getInfo()
            if type(info) = "roAssociativeArray"
                if info.audioCodecCapabilityChanged = true or info.videoCodecCapabilityChanged = true
                    m.routeEpoch = m.routeEpoch + 1
                    m.top.event = FormatJson({ type: "capabilities", routeEpoch: m.routeEpoch })
                end if
                if info.doesExist("audioGuideEnabled")
                    m.top.event = FormatJson({ type: "system", snapshot: { screenReader: info.audioGuideEnabled } })
                end if
                if info.doesExist("appFocused")
                    appState = "inactive"
                    if info.appFocused = true then appState = "active"
                    m.top.event = FormatJson({ type: "system", snapshot: { appState: appState } })
                end if
                if info.doesExist("generalMemoryLevel")
                    m.top.event = FormatJson({ type: "memory", level: info.generalMemoryLevel })
                end if
            end if
        end if
    end while
    m.device.enableCodecCapChangedEvent(false)
    m.device.enableAudioGuideChangedEvent(false)
    m.device.enableAppFocusEvent(false)
    m.device.enableLowGeneralMemoryEvent(false)
end sub

function probeDeviceFacts(request as Object) as Object
    if type(request.video) <> "roArray" or type(request.audio) <> "roArray" then return { error: "Invalid decoder query arrays" }
    if request.video.count() > 32 or request.audio.count() > 32 then return { error: "Decoder query limit exceeded" }
    video = {}
    audio = {}
    for each query in request.video
        video[query.id] = m.device.canDecodeVideo(query.format)
    end for
    for each query in request.audio
        audio[query.id] = m.device.canDecodeAudio(query.format)
    end for
    display = m.device.getDisplayProperties()
    hdcp22 = false
    hdmi = CreateObject("roHdmiStatus")
    if hdmi <> invalid then hdcp22 = hdmi.isHdcpActive("2.2")
    return { facts: { schema: "react-native-roku-device-facts/v1", timeZone: m.device.getTimeZone(), model: m.device.getModel(), firmware: m.device.getVersion(), modelType: m.device.getModelType(), videoMode: m.device.getVideoMode(), hdcp22: hdcp22, audioOutput: m.device.getAudioOutputChannel(), routeEpoch: m.routeEpoch, video: video, audio: audio, display: { hdr10: display.hdr10, hdr10plus: display.hdr10plus, dolbyvision: display.dolbyvision, hlg: display.hlg } } }
end function
