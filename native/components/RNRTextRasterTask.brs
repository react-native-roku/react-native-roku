sub init()
    m.top.functionName = "runRaster"
end sub

sub runRaster()
    namespace = m.top.namespace
    if not CreateObject("roRegex", "^[a-zA-Z0-9-]{1,80}$", "").isMatch(namespace) then return
    m.directory = "tmp:/react-native-roku-text-" + namespace
    m.fs = CreateObject("roFileSystem")
    m.fs.createDirectory(m.directory)
    m.paths = {}
    m.fonts = {}
    port = CreateObject("roMessagePort")
    m.top.observeField("command", port)
    command = m.top.command
    while true
        if command <> ""
            request = ParseJson(command)
            if request <> invalid
                if request.type = "dispose" then exit while
                reply = rasterOperation(request)
                reply.id = request.id
                m.top.reply = FormatJson(reply)
            end if
        end if
        message = wait(0, port)
        if type(message) = "roSGNodeEvent" then command = message.getData() else command = ""
    end while
    for each path in m.paths
        m.fs.delete(path)
    end for
    m.fs.delete(m.directory)
end sub

function rasterOperation(request as Object) as Object
    if request.type = "mask"
        if request.width < 1 or request.height < 1 or request.width > 2048 or request.height > 2048 then return { error: "Invalid native text bitmap dimensions" }
        if request.size < 1 or request.size > 512 then return { error: "Invalid native text font size" }
        if left(request.font, 11) <> "pkg:/fonts/" then return { error: "Text raster font must be packaged" }
        registry = m.fonts[request.font]
        if registry = invalid
            registry = CreateObject("roFontRegistry")
            if not registry.register(request.font) then return { error: "Native raster font registration failed" }
            m.fonts[request.font] = registry
        end if
        families = registry.getFamilies()
        if families.count() <> 1 then return { error: "Native raster font family is ambiguous" }
        font = registry.getFont(families[0], request.size, false, false)
        if font = invalid then return { error: "Native raster font creation failed" }
        if abs(font.getOneLineHeight() - request.lineHeight) > 2 then return { error: "Label and bitmap font line metrics differ" }
        bitmap = CreateObject("roBitmap", { width: request.width, height: request.height, alphaEnable: true })
        if bitmap = invalid then return { error: "Native text bitmap allocation failed" }
        bitmap.clear(&h00000000)
        if request.commands.count() > 4096 then return { error: "Native text command budget exceeded" }
        for each draw in request.commands
            if not bitmap.drawText(draw.text, int(draw.x + 0.5), int(draw.y + 0.5), &hFFFFFFFF, font) then return { error: "Native text drawing failed" }
        end for
        pixels = bitmap.getByteArray(0, 0, request.width, request.height)
        if pixels = invalid then return { error: "Native text bitmap readback failed" }
        return { pixels: pixels.toBase64String() }
    else if request.type = "write"
        if not CreateObject("roRegex", "^text-[0-9]+\.png$", "").isMatch(request.name) then return { error: "Invalid native text asset name" }
        path = m.directory + "/" + request.name
        bytes = CreateObject("roByteArray")
        bytes.fromBase64String(request.data)
        if not bytes.writeFile(path) then return { error: "Native text asset write failed" }
        m.paths[path] = true
        return { uri: path }
    else if request.type = "delete"
        if m.paths[request.uri] <> invalid
            if not m.fs.delete(request.uri) then return { error: "Native text asset removal failed" }
            m.paths.delete(request.uri)
        end if
        return {}
    end if
    return { error: "Unsupported native text operation" }
end function
