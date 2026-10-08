


/* AsAPI: Start @early inject */
window.AsAPI = { ...window.AsAPI,  // early inject
    // 用于检查对象或数组是否有效
    isvalid: function(dict) {
        if (dict instanceof Object) {
            return dict && Object.keys(dict).length > 0
        } else {
            return dict && dict.length > 0
        }
    },
    // 用于在故事字幕中添加内容
    addStoryCaptionContent: function(content) {
        setTimeout(() => {
            const container = document.getElementById("storyCaptionContent");
            if (container) {
                // 插入在第一个位置
                const newCaption = document.createElement("div");
                newCaption.innerHTML = content + "<br>";
                container.insertAdjacentElement('afterbegin', newCaption);
            }
            document.getElementById("ui-bar").classList.remove("stowed");
        });
    },
    // 用于加载远程数据并显示在元素中
    loadRemote: function() {
        queueMicrotask(() => { 
            document.querySelectorAll('[data-remote]').forEach(async element => {
                try {
                const response = await fetch(element.dataset.remote, {
                    mode: 'cors',
                    credentials: 'omit'
                });
                const data = await response.json();
                if (!data.error) {
                    let content = data.value;
                    if (element.dataset.replace === 'true') {
                    content = content.replaceAll('\n', '<br>');
                    }
                    element.innerHTML = content;
                }
                } catch (error) {
                element.innerHTML = element.dataset.error || '加载失败';
                }
            });
        });
    },
    // 将小时数转换为友好的时间文本
    getFriendlyTimeText: function(ageHours, cn = true) {
        const hours = Math.floor(ageHours);
        let friendlyTimeText = ""
        if (hours) {
            friendlyTimeText += `${hours}${cn? '小时': ':'}`;
        } else {
            if (!cn) friendlyTimeText += `0:`;
        }
        const minutes = Math.round((ageHours - hours) * 60);
        if (minutes) {
            if (cn) {friendlyTimeText += `${minutes}分钟`}
            else {friendlyTimeText += `${minutes}`.padStart(2, '0')};
        } else {
            if (!cn) friendlyTimeText += `00`;
        }
        return friendlyTimeText
    },
    // 颜色打印
    log: function(title, content, title_color = 'green', content_color = 'white', func = 'log') {
        let text = "";
        const styles = [];
        if (title) {
            text += `%c ${title} %c`;
            styles.push(`background: ${title_color}; color: black; padding: 2px 4px; border-radius: 3px;`);
        }
        if (content) {
            text += ` ${content}`;
            styles.push(`color: ${content_color};`);
        }
        console[func](text, ...styles);
    },
    // 警告
    warn: function(title, content, title_color = 'green') { this.log(title, content, title_color, 'yellow', "warn") },
    // 错误
    error: function(title, content, title_color = 'green') { this.log(title, content, title_color, 'red', "error") },
    // Debug
    debug: function(title, content, title_color = 'yellow') { if (AsAPI.debugon) this.log(title, content, title_color, 'gray', "warn") },
    debugon: false,
    // 【工具】注入游戏函数，在调用原函数后再执行指定的功能。
    onFunction: function(originalFn, afterFn) {
        return new Proxy(originalFn, {
            apply: function(target, thisArg, argumentsList) {
                // const result = target.apply(thisArg, argumentsList);
                afterFn(...argumentsList);
                return target.apply(thisArg, argumentsList);
            }
        });
    },
    // 【工具】注入游戏宏，在调用原宏后再执行指定的功能。
    onMacro: function(macroName, afterFn) {
        let originalMacro = SugarCube.Macro.get(macroName);
        if (originalMacro) {
            let oldHandler = originalMacro.handler;
            SugarCube.Macro.delete(macroName);
            SugarCube.Macro.add(macroName, {
                handler: function () {
                    oldHandler.apply(this, arguments);
                    afterFn.apply(this, arguments);
                }
            });
        }
    },
    // 【工具】自动处理函数和宏的注入，请使用of$和om$来进行使用，请确保与原函数或宏重名。
    autoinject(modnamespace, modname, modcolor = "green") {
        $(document).one(":passageinit", function () {
            asi.debug(modname, "开始自动注入函数和宏")
            const ns = window[modnamespace];
            if (!ns || typeof ns !== 'object') {
                asi.error(modname, `命名空间 ${modnamespace} 不存在，跳过注入`, modcolor);
                return;
            }
            asi.debug(modname, `命名空间 ${modnamespace} 检查通过，开始注入函数和宏` + ns);
            const keys = Object.keys(ns);
            keys.forEach(key => {
                asi.debug(modname, `检查 ${key} 是否需要注入`)
                // 自动处理 of$ 前缀：绑定到全局同名函数
                if (key.startsWith('of$')) {
                    const funcName = key.slice(3);
                    eval(`${funcName} = asi.onFunction(${funcName}, ${modnamespace}['of$${funcName}'])`);
                    asi.log(modname, `已注入 onFunction: ${funcName}`, modcolor);
                }
                // 自动处理 om$ 前缀：使用 onMacro 注入宏
                else if (key.startsWith('om$')) {
                    const macroName = key.slice(3);
                    asi.onMacro(macroName, ns[key]);
                    asi.log(modname, `已注入 onMacro: ${macroName}`, modcolor);
                }
            });
            asi.log(modname, `已自动完成所有函数和宏注入`, modcolor, "green");
        });
    },
    // 当没有 event 时重新加载当前 passage
    reload: function() {
        if (!V.event) {
            SugarCube.Engine.play(passage());
            return true;
        }
        return false;
    },
}
Object.defineProperty(window, 'asi', { get() { return window.AsAPI; }, configurable: true });
/* AsAPI: End @early inject */



/* AsAPI: Start @inject */

/* AsAPI: End @inject */

