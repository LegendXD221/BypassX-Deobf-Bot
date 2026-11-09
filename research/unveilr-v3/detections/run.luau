local process = require("@lune/process")
local fs = require("@lune/fs")

for i = 1, 13 do
    local path = `detections/{i}.lua`
    if not fs.isFile(path) then continue end
    print(process.exec("lune", {
        "run",
        "main",
        path,
        `out=dtc{i}.lua`
    }))
end