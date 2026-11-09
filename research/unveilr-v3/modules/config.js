const print = console.log
const aliases = {
    speed: "performance",
    antitamper: "tamper",
    accuracy: "output"
}

const settingValues = {
    performance: {
        hookOp: -2,
        runtimelogs: -1,
        inf_loops: -1,
        constants: -2
    },
    output: {
        hookOp: 3,
        explore_funcs: 1,
        spyexeconly: -1,
        minifier: 5,
        lua: 3,
        roblox: -1,
        discord: 1
    },
    tamper: {
        hookOp: 5,
        spyexeconly: 4,
        constants: 3,
        lua: -1,
        roblox: 3
    }
}

const validOptions = Object.keys(settingValues).join(", ")

/**
 @param {string} optionsStr
 @returns {Object<boolean, Record<string, boolean>>}
*/
const bestCfg = (optionsStr) => {
    const config = {}
    // performance:
    // hookOp: -2, disable hookOp

    for (let option of optionsStr.replace(" ", "").split(",")) {
        const difference = settingValues[aliases[option] || option]
        if(!difference) return [ false, "Invalid option, the only valid options are: " + (validOptions) ]

        for (let settingName in difference) {
            const change = difference[settingName]

            if (typeof config[settingName] === "undefined")
                config[settingName] = change
            else
                config[settingName] += change

            //if (typeof config[option] === "undefined")
              //  print(option)
        }
    }

    const fixed = {}

    for (let i in config) 
        fixed[i] = config[i] > 0

    return [ true, fixed ]
}

module.exports = bestCfg;