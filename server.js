const scriptCode = /*javascript*/`
(function() {
    let modifyShaders = true
    let disable_detachShader = false

    const canvas_list = []
    const context_list = []

    const oCanvasGetContext = HTMLCanvasElement.prototype.getContext

    HTMLCanvasElement.prototype.getContext = function (contextType, contextAttributes) {
        const context = oCanvasGetContext.call(this, contextType, contextAttributes)

        if (contextType == "experimental-webgl" || contextType == "webgl" || contextType == "webgl2") {
            if (context && context_list.indexOf(context) === -1) {
                context_list.push(context)
                try {
                    initHack(contextType, context)
                } catch (e) {
                    alert(e)
                }
            }
        } else {
            console.warn("contextType " + contextType + " is not supported")
        }

        return context
    }

    function initHack(contextType, gl) {
        let objectSelector = true
        let isSelectingObject = false
        let objects = []
        let selectedObjs = []

        const options = {
            gWireframeMode: {
                text: "Map Wireframe",
                type: "toggle",
                value: false
            },
            asusWallhack: {
                text: "ASUS Wallhack",
                type: "toggle",
                value: false
            },
            whiteSpace1: {
                text: "",
                type: "none"
            },
            objSelector: {
                text: "Object Selector",
                type: "range",
                min: 0,
                max: 0,
                value: 0
            },
            objWallhack: {
                text: "Wallhack",
                type: "toggle",
                value: true
            },
            objChams: {
                text: "Chams",
                type: "toggle",
                value: true
            },
            objOutline: {
                text: "Outline",
                type: "toggle",
                value: false
            },
            objWireframe: {
                text: "Wireframe",
                type: "toggle",
                value: false
            },
            objAimbot: {
                text: "Aimbot",
                type: "toggle",
                value: false
            },
            objAimbotFOV: {
                text: "Aimbot FOV",
                type: "range",
                min:  1,
                max: 30,
                value: 8
            },
            objAimbotForce: {
                text: "Aimbot Force",
                type: "range",
                min:  1,
                max: 100,
                value: 10
            },
            objESP: {
                text: "ESP Lines",
                type: "toggle",
                value: false
            },
            objOffsetX: {
                text: "Offset X",
                type: "range",
                style: "simple",
                min:  -100,
                max: 100,
                value: 0
            },
            objOffsetY: {
                text: "Offset Y",
                type: "range",
                style: "simple",
                min:  -100,
                max: 100,
                value: 0
            },
            objOffsetZ: {
                text: "Offset Z",
                type: "range",
                style: "simple",
                min:  -100,
                max: 100,
                value: 0
            }
        }


        const oShaderSource =  gl.shaderSource
        const oDetachShader = gl.detachShader
        const oDrawElements = gl.drawElements
        const oDrawArrays = gl.drawArrays

        //webgl2 only
        const oDrawElementsInstanced = gl.drawElementsInstanced
        const oDrawArraysInstanced = gl.drawArraysInstanced
        const oDrawRangeElements = gl.drawRangeElements
        const oDrawBuffers = gl.drawBuffers

        gl.shaderSource = (shader, source) => {
            if (!modifyShaders) return oShaderSource.call(gl, shader, source);

            let _source = source

            let version = 100
            const version_match = source.split("\\n")[0].match(/\\s*#version\\s+([0-9]+)/)
            if (version_match) {
                version = parseInt(version_match[1])
            }

            const shader_type = gl.getShaderParameter(shader, gl.SHADER_TYPE)

            if (shader_type === gl.VERTEX_SHADER) {
                let attr = "in"
                let vary = "out"
                if (version < 300) {
                    attr = "attribute"
                    vary = "varying"
                }

                _source = _source.replace(/void\\s+main\\s*\\([void\\s]*\\)\\s*\\{/, '\\n'+
                'uniform lowp float aenableChams;\\n'+
                vary + ' lowp float enableChams;\\n'+
                'uniform lowp vec3 achamsColor;\\n'+
                vary + ' lowp vec3 chamsColor;\\n'+
                'uniform lowp float aScale;\\n'+
                'uniform lowp float aBlend;\\n'+
                vary + ' lowp float blend;\\n'+
                'void main()\\n'+
                '{\\n'+
                    'enableChams = aenableChams;\\n'+
                    'chamsColor = achamsColor;\\n'+
                    'blend = aBlend;\\n'+
                '\\n')

                // outline unity
                _source = _source.replace("u_xlat0 = in_POSITION0.yyyy * hlslcc_mtx4x4unity_ObjectToWorld[1];", "u_xlat0 = (aScale*in_POSITION0.yyyy) * hlslcc_mtx4x4unity_ObjectToWorld[1];")
                _source = _source.replace("u_xlat0 = hlslcc_mtx4x4unity_ObjectToWorld[0] * in_POSITION0.xxxx + u_xlat0;", "u_xlat0 = hlslcc_mtx4x4unity_ObjectToWorld[0] * (aScale*in_POSITION0.xxxx) + u_xlat0;")
                _source = _source.replace("u_xlat0 = hlslcc_mtx4x4unity_ObjectToWorld[2] * in_POSITION0.zzzz + u_xlat0;", "u_xlat0 = hlslcc_mtx4x4unity_ObjectToWorld[2] * (aScale*in_POSITION0.zzzz) + u_xlat0;")
            
                // outline others
                _source = _source.replace("gl_Position = mvp * vec4(inputPosition, 1.0);", "gl_Position = mvp * vec4(inputPosition.xyz * aScale, 1.0);")
            } else if (shader_type === gl.FRAGMENT_SHADER) {
                let vary = "in"
                let fragColor = null

                if (version < 300) {
                    vary = "varying"
                    if (_source.indexOf("gl_FragData") !== -1) {
                        fragColor = "gl_FragData[0]"
                    } else {
                        fragColor = "gl_FragColor"
                    }
                } else {
                    const fragColor_match = _source.match(/out\\s+[a-zA-Z0-9_]*\\s*vec4\\s+([a-zA-Z0-9_]+)\\s*;/)
                    if (fragColor_match) {
                        fragColor = fragColor_match[1]
                    } else {
                        alert("FragColor not found in shader")
                    }
                }

                _source = _source.replace(/void\\s+main\\s*\\([void\\s]*\\)\\s*\\{/, '\\n'+
                vary + ' lowp float enableChams;\\n'+
                vary + ' lowp vec3 chamsColor;\\n'+
                vary + ' lowp float blend;\\n'+
                'void main()\\n'+
                '{\\n'+
                '   if (enableChams == 1.0) {\\n'+
                        fragColor + ' = vec4(chamsColor, 1.0);\\n'+
                '        return;\\n'+
                '    }\\n'+
                '\\n')

                // blend unity
                _source = _source.replace(fragColor + ".w = 1.0;", fragColor + ".w = blend < 1.0 ? blend : " + fragColor + ".w;")

                // blend others
                _source = _source.replace("gl_FragColor = color;", "gl_FragColor = color; gl_FragColor.w = blend < 1.0 ? blend : gl_FragColor.w;")
            }

            oShaderSource.call(gl, shader, _source)
            gl.compileShader(shader)

            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                alert(gl.getShaderInfoLog(shader))
                debugger
                oShaderSource.call(gl, shader, source)
            }
        }

        gl.detachShader = (program, shader) => {
            if (!modifyShaders) return oDetachShader.call(gl, program , shader);
            if (!disable_detachShader) return oDetachShader.call(gl, program , shader);
        }


        // transformMat4 (vec3, vec3, mat4) : vec3
        function transformMat4(out, a, m) {
            let x = a[0], y = a[1], z = a[2], w = a[3];
          
            out[0] = m[0] * x + m[4] * y + m[ 8] * z + m[12] * w;
            out[1] = m[1] * x + m[5] * y + m[ 9] * z + m[13] * w;
            out[2] = m[2] * x + m[6] * y + m[10] * z + m[14] * w;
            out[3] = m[3] * x + m[7] * y + m[11] * z + m[15] * w;
          
            return out;
        }

        // transformMat4 (mat4, mat4, mat4) : mat4
        function multiplyMatrix(out, a, b) {
            let a00 = a[ 0], a01 = a[ 1], a02 = a[ 2], a03 = a[ 3];
            let a10 = a[ 4], a11 = a[ 5], a12 = a[ 6], a13 = a[ 7];
            let a20 = a[ 8], a21 = a[ 9], a22 = a[10], a23 = a[11];
            let a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
        
            // Cache only the current line of the second matrix
            let b0, b1, b2, b3;
        
            b0 = b[0];
            b1 = b[1];
            b2 = b[2];
            b3 = b[3];

            out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        
            b0 = b[4];
            b1 = b[5];
            b2 = b[6];
            b3 = b[7];
        
            out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        
            b0 = b[8];
            b1 = b[9];
            b2 = b[10];
            b3 = b[11];
        
            out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        
            b0 = b[12];
            b1 = b[13];
            b2 = b[14];
            b3 = b[15];
        
            out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
            out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
            out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
            out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
        
            return out;
        }

        function createMatrix() {
            let out = [
                0, 0, 0, 0,
                0, 0, 0, 0,
                0, 0, 0, 0,
                0, 0, 0, 0
            ];
            return out;
        }

        let allEntitiesPos = []

        function hDraw(mode, count, oDraw) {
            if (objects.indexOf(count) === -1) {
                objects.push(count)
                options.objSelector.max = objects.length
            }

            const currentProgram = gl.getParameter(gl.CURRENT_PROGRAM)
            
            const _chamsColor = gl.getUniformLocation(currentProgram, "achamsColor")
            const _enableChams = gl.getUniformLocation(currentProgram, "aenableChams")
            const _scale = gl.getUniformLocation(currentProgram, "aScale")
            const _blend = gl.getUniformLocation(currentProgram, "aBlend")

            if (_chamsColor) gl.uniform3f(_chamsColor, 0.0, 0.0, 0.0);
            if (_enableChams) gl.uniform1f(_enableChams, 0.0);
            if (_scale) gl.uniform1f(_scale, 1.0);
            if (_blend) gl.uniform1f(_blend, 1.0);
            
            const blendIsEnabled = gl.isEnabled(gl.BLEND)
            const stencilTestIsEnabled = gl.isEnabled(gl.STENCIL_TEST)

            if (options.asusWallhack.value && _blend) {
                gl.enable(gl.BLEND)
                gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

                gl.uniform1f(_blend, 0.5)
            }

            if (options.gWireframeMode.value) {
                mode = gl.LINES
            }


            const objIdx = options.objSelector.value-1
            const isSelectedObj = isSelectingObject && objects[objIdx] === count
            
            if ((objectSelector /*&& isSelectingObject*/ && objIdx > -1 && objects[objIdx] === count) || (/*!objectSelector && */selectedObjs.indexOf(count) !== -1)) {
                window.playerProgram = currentProgram
                window.gl = gl

                let mvpMatrix = null

                // unity games
                const mLocation0  = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_ObjectToWorld[0]")
                const mLocation1  = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_ObjectToWorld[1]")
                const mLocation2  = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_ObjectToWorld[2]")
                const mLocation3  = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_ObjectToWorld[3]")
                const vpLocation0 = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_MatrixVP[0]")
                const vpLocation1 = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_MatrixVP[1]")
                const vpLocation2 = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_MatrixVP[2]")
                const vpLocation3 = gl.getUniformLocation(currentProgram, "hlslcc_mtx4x4unity_MatrixVP[3]")
                if (mLocation0 && mLocation3 && vpLocation0 && vpLocation3) {
                    const mVector0   = gl.getUniform.call(gl, currentProgram, mLocation0 )
                    const mVector1   = gl.getUniform.call(gl, currentProgram, mLocation1 )
                    const mVector2   = gl.getUniform.call(gl, currentProgram, mLocation2 )
                    const mVector3   = gl.getUniform.call(gl, currentProgram, mLocation3 )
                    const vpVector0  = gl.getUniform.call(gl, currentProgram, vpLocation0)
                    const vpVector1  = gl.getUniform.call(gl, currentProgram, vpLocation1)
                    const vpVector2  = gl.getUniform.call(gl, currentProgram, vpLocation2)
                    const vpVector3  = gl.getUniform.call(gl, currentProgram, vpLocation3)

                    const mMatrix  = [
                        mVector0[0], mVector0[1], mVector0[2], mVector0[3],
                        mVector1[0], mVector1[1], mVector1[2], mVector1[3],
                        mVector2[0], mVector2[1], mVector2[2], mVector2[3],
                        mVector3[0], mVector3[1], mVector3[2], mVector3[3]
                    ]
                    const vpMatrix  = [
                        vpVector0[0], vpVector0[1], vpVector0[2], vpVector0[3],
                        vpVector1[0], vpVector1[1], vpVector1[2], vpVector1[3],
                        vpVector2[0], vpVector2[1], vpVector2[2], vpVector2[3],
                        vpVector3[0], vpVector3[1], vpVector3[2], vpVector3[3]
                    ]

                    mvpMatrix = createMatrix()
                    multiplyMatrix(mvpMatrix, vpMatrix, mMatrix)
                }

                // others games
                const mvpLocation = gl.getUniformLocation(currentProgram, "u_ModelViewProjectionMatrix") || gl.getUniformLocation(currentProgram, "mvp")
                if (mvpLocation) {
                    mvpMatrix = gl.getUniform(currentProgram, mvpLocation)
                }

                if (mvpMatrix) {
                    const xyzw = [options.objOffsetX.value/10, options.objOffsetY.value/10, options.objOffsetZ.value/10, 1]
                    transformMat4(xyzw, xyzw, mvpMatrix)
                    const pos = [xyzw[0] / xyzw[3], xyzw[1] / xyzw[3], xyzw[2] / xyzw[3], xyzw[3]]
                    allEntitiesPos.push(pos)
                }

                if (options.objWireframe.value) {
                    mode = gl.LINES
                }

                        /*
                        const activeTexture = gl.getParameter(gl.ACTIVE_TEXTURE)
                        const textureBinding2D = gl.getParameter(gl.TEXTURE_BINDING_2D)

                        gl.activeTexture(gl.TEXTURE0);

                        const texture = gl.createTexture();
                        gl.bindTexture(gl.TEXTURE_2D, texture);
                        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
                                    new Uint8Array([0, 0, 255, 255]));
                    
                        gl.uniform1i(gl.getUniformLocation(currentProgram, "_MainTex"), 0)
                        //*/

                if (options.objChams.value && _enableChams && _chamsColor) {
                    gl.uniform1f(_enableChams, 1.0)

                    // desenha partes atras de objetos
                    if (options.objWallhack.value) {
                        gl.disable(gl.DEPTH_TEST)

                        if (isSelectedObj) {
                            gl.uniform3f(_chamsColor, 0.0, 1.0, 0.0)
                        } else {
                            gl.uniform3f(_chamsColor, 1.0, 1.0, 0.0)
                        }
                        oDraw(mode)

                        gl.enable(gl.DEPTH_TEST)
                    }

                    // desenha partes há frente dos objetos
                    if (isSelectedObj) {
                        gl.uniform3f(_chamsColor, 0.0, 1.0, 0.0)
                    } else {
                        gl.uniform3f(_chamsColor, 1.0, 0.0, 0.0)
                    }
                    oDraw(mode)
                } else if (options.objOutline.value && _scale && _enableChams && _chamsColor) {
                    gl.enable(gl.STENCIL_TEST)
                    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE)

                    // desenha partes atras de objetos
                    if (options.objWallhack.value) {
                        gl.disable(gl.DEPTH_TEST)

                        if (isSelectedObj) {
                            gl.uniform3f(_chamsColor, 0.0, 1.0, 0.0)
                        } else {
                            gl.uniform3f(_chamsColor, 1.0, 1.0, 0.0)
                        }

                        gl.stencilFunc(gl.ALWAYS, 1, 0xFF)
                        gl.stencilMask(0xFF)
                        gl.uniform1f(_enableChams, 0.0)
                        gl.uniform1f(_scale, 1.0)
                        oDraw(mode)
            
                        gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF)
                        gl.stencilMask(0x00)
                        gl.uniform1f(_enableChams, 1.0)
                        gl.uniform1f(_scale, 1.1)
                        oDraw(mode)

                        gl.enable(gl.DEPTH_TEST)
                    }

                    // desenha partes há frente dos objetos
                    if (isSelectedObj) {
                        gl.uniform3f(_chamsColor, 0.0, 1.0, 0.0)
                    } else {
                        gl.uniform3f(_chamsColor, 1.0, 0.0, 0.0)
                    }

                    gl.stencilFunc(gl.ALWAYS, 1, 0xFF)
                    gl.stencilMask(0xFF)
                    gl.uniform1f(_enableChams, 0.0)
                    gl.uniform1f(_scale, 1.0)
                    oDraw(mode)
        
                    gl.stencilFunc(gl.NOTEQUAL, 1, 0xFF)
                    gl.stencilMask(0x00)
                    gl.uniform1f(_enableChams, 1.0)
                    gl.uniform1f(_scale, 1.1)
                    oDraw(mode)
                } else {
                    // desenha partes atras de objetos
                    if (options.objWallhack.value) {
                        gl.disable(gl.DEPTH_TEST)
                        oDraw(mode)
                        gl.enable(gl.DEPTH_TEST)
                    }

                    // desenha partes há frente dos objetos
                    oDraw(mode)                   
                }
            } else {
                oDraw(mode)
            }

            if (_chamsColor) gl.uniform3f(_chamsColor, 0.0, 0.0, 0.0);
            if (_enableChams) gl.uniform1f(_enableChams, 0.0);
            if (_scale) gl.uniform1f(_scale, 1.0);
            if (_blend) gl.uniform1f(_blend, 1.0);

            if (blendIsEnabled) {
                gl.enable(gl.BLEND)
            } else {
                gl.disable(gl.BLEND)
            }

            if (stencilTestIsEnabled) {
                gl.enable(gl.STENCIL_TEST)
            } else {
                gl.disable(gl.STENCIL_TEST)
            }

            //gl.bindTexture(gl.TEXTURE_2D, textureBinding2D)
            //gl.uniform1i(gl.getUniformLocation(currentProgram, "_MainTex"), 0)
           // gl.activeTexture(activeTexture)
        }

        gl.drawElements = (mode, count, type, offset) => {
            hDraw(mode, count, function (mode) {
                oDrawElements.call(gl, mode, count, type, offset)
            })
        }

        gl.drawArrays = (mode, first, count) => {
            hDraw(mode, count, function (mode) {
                oDrawArrays.call(gl, mode, first, count)
            })
        }

        gl.drawElementsInstanced = (mode, count, type, offset, instanceCount) => {
            hDraw(mode, count, function (mode) {
                oDrawElementsInstanced.call(gl, mode, count, type, offset, instanceCount)
            })
        }

        gl.drawArraysInstanced = (mode, first, count, instanceCount) => {
            hDraw(mode, count, function (mode) {
                oDrawArraysInstanced.call(gl, mode, first, count, instanceCount)
            })
        }

        gl.drawRangeElements = (mode, start, end, count, type, offset) => {
            hDraw(mode, count, function (mode) {
                oDrawRangeElements.call(gl, mode, start, end, count, type, offset)
            })
        }

        gl.drawBuffers = (buffers) => {
            oDrawBuffers.call(gl, buffers)
        }



        function isInViewport(rect) {
            return (
                rect.top >= 0 &&
                rect.left >= 0 &&
                rect.bottom > 0 &&
                rect.right > 0 &&
                rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
                rect.right <= (window.innerWidth || document.documentElement.clientWidth)
            );
        }

        let menuCanvas = null
        let menuIsVisible = false
        let showMenu = true

        function updateCanvasPosition() {
            const rect = gl.canvas.getBoundingClientRect();

            if (menuCanvas) {
                menuCanvas.style.top = rect.top + "px"
                menuCanvas.style.left = rect.left + "px"
                //menuCanvas.style.width = rect.width + "px"
                //menuCanvas.style.height = rect.height + "px"

                if (isInViewport(rect) && (showMenu || options.objESP.value)) {
                    menuCanvas.style.display = "block"
                    menuIsVisible = true
                } else {
                    menuCanvas.style.display = "none"
                    menuIsVisible = false
                }
            } else if (isInViewport(rect)) {
                const div = document.createElement("div")
                const shadow = div.attachShadow({mode: "open"})
                menuCanvas = document.createElement("canvas")
                shadow.appendChild(menuCanvas)
                document.documentElement.appendChild(div)
                const menu = createMenu(menuCanvas, options)
                menuIsVisible = true
            }
        }
        setInterval(updateCanvasPosition, 100);

        function createMenu(canvas, options) {
            const marginTop = 30
            const marginLeft = 12
            const backgroundColor = "#367ff5"
            const menuBorderColor = "#000000"
            const selectedBackgroundColor = "#bad1f5"
            const enabledColor = "#00ff40"
            const disabledColor = "#ff8000"
            const rangeColor = "#ddff00"
            const font = "16px sans-serif"
            const textColor = "black"
            const optionPadding = 25
            const optionMarginTop = 5

            let selectedIndex = 0

            let menu_width = 260
            let menu_height = 615
            let menu_right = menu_width + 10
            let menu_bottom = menu_height + 10

            canvas.style = "display: block !important;position: fixed !important; /*visibility: hidden !important;*/ top: 0 !important; left: 0 !important; width: 250px !important; height: 360px !important; z-index: 999999 !important; pointer-events: none !important;"
            canvas.width = gl.canvas.width
            canvas.height = gl.canvas.height

            canvas.style.width = canvas.width + "px"
            canvas.style.height = canvas.height + "px"
            
            /** @type {CanvasRenderingContext2D} */
            const ctx = canvas.getContext("2d")

            function renderMenuCanvas(allEntitiesPos) {
                ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight)
                ctx.beginPath()

                if (options.objESP.value) {
                    const viewWidth = gl.canvas.width
                    const viewHeight = gl.canvas.height

                    function convertToWC(x, y) {
                        return [parseInt((x+1)/2 * viewWidth), parseInt(viewHeight-((y+1)/2 * viewHeight))]
                    }

                    ctx.strokeStyle = "blue"
                    allEntitiesPos.forEach(pos => {
                        const wcPos = convertToWC(pos[0], pos[1])
                        ctx.beginPath()
                        ctx.moveTo(parseInt(viewWidth/2), viewHeight)
                        ctx.lineTo(wcPos[0], wcPos[1])
                        ctx.stroke()
                    })
                }

                if (!showMenu) return;
                
                ctx.beginPath()

                ctx.globalAlpha = 0.6
                ctx.strokeStyle = menuBorderColor
                ctx.fillStyle = backgroundColor
                ctx.rect(10, 10, menu_width, menu_height)
                ctx.fill()
                ctx.stroke()
                ctx.globalAlpha = 1.0

                ctx.beginPath()

                let top = marginTop + 10
                let left = marginLeft + 10
                
                ctx.fillStyle = selectedBackgroundColor
                ctx.fillRect(left, selectedIndex*optionPadding+20, menu_right-marginLeft*2-10, optionPadding)

                ctx.font = font

                function drawOption(textLeft, textRight, colorLeft=textColor, colorRight=textColor) {
                    if (textLeft) {
                        ctx.fillStyle = colorLeft
                        ctx.fillText(textLeft, left+5, top)
                    }

                    if (textRight) {
                        ctx.fillStyle = colorRight
                        const txtWidth = ctx.measureText(textRight).width
                        ctx.fillText(textRight, menu_right-txtWidth-20, top)
                    }

                    top += optionPadding
                }

                for (const optName of Object.keys(options)) {
                    const option = options[optName]

                    const colorLeft = textColor
                    let colorRight = colorLeft

                    let value = ""
                    let displayText = option.text

                    if (optName === "objSelector") {
                        const objIdx = option.value - 1
                        const currentId = (objIdx >= 0 && objects[objIdx] !== undefined) ? objects[objIdx] : 0
                        displayText = "Object Selector (ID: " + currentId + ")"
                    }

                    if (option.type == "toggle") {
                        if (option.value) {
                            value = " ON"
                            colorRight = enabledColor
                        } else {
                            value = "OFF"
                            colorRight= disabledColor
                        }
                    } else if (option.type == "range" && option.style == "simple") {
                        value = "<" + option.value + ">"
                        colorRight = rangeColor
                    } else if (option.type == "range") {
                        value = "<" + option.value + "/" + option.max + ">"
                        colorRight = rangeColor
                    }
                    
                    drawOption(displayText, value, colorLeft, colorRight)
                }

                drawOption()
                drawOption("Scrool Up: "  , "\u2191")
                drawOption("Scrool Down: ", "\u2193")
                drawOption("Dec Valor: "  , "\u2190")
                drawOption("Inc value: "  , "\u2192")
                drawOption("Add Object: "  , "Ins")
                drawOption("Del Object: "  , "Del")
                drawOption("Aimbot Toggle: "  , "MID_MOUSE")
                drawOption("Hide/Show: "  , "*")

                ctx.fill()
            }


            const vertShaderSrc = 
                'attribute vec2 a_position;'+
                'uniform mat3 u_matrix;'+
                'varying vec2 v_texCoord;'+
                'void main() {'+
                    'gl_Position = vec4(u_matrix * vec3(a_position, 1), 1);'+
                    'v_texCoord = a_position;'+
                '}'

            const fragShaderSrc =
                'precision mediump float;'+
                'uniform sampler2D u_image;'+
                'varying vec2 v_texCoord;'+
                'void main() {'+
                    'gl_FragColor = texture2D(u_image, v_texCoord);'+
                '}'

            const vertShader = gl.createShader(gl.VERTEX_SHADER)
            const fragShader = gl.createShader(gl.FRAGMENT_SHADER)

            oShaderSource.call(gl, vertShader, vertShaderSrc)
            oShaderSource.call(gl, fragShader, fragShaderSrc)

            gl.compileShader(vertShader)
            gl.compileShader(fragShader)

            const menuProgram = gl.createProgram()
            gl.attachShader(menuProgram, vertShader)
            gl.attachShader(menuProgram, fragShader)
            gl.linkProgram(menuProgram)

            var positionLocation = gl.getAttribLocation(menuProgram, "a_position"); 

            var u_imageLoc = gl.getUniformLocation(menuProgram, "u_image");
            var u_matrixLoc = gl.getUniformLocation(menuProgram, "u_matrix");

            var positionBuffer = gl.createBuffer();
            var texture = gl.createTexture();

            function renderMenuInWebGL() {
                const origProgram = gl.getParameter(gl.CURRENT_PROGRAM)
                const origBuffer = gl.getParameter(gl.ARRAY_BUFFER_BINDING)
                const origTexture = gl.getParameter(gl.TEXTURE_BINDING_2D)

                gl.useProgram(menuProgram);
                
                gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
                    0.0,  0.0,
                    1.0,  0.0,
                    0.0,  1.0,
                    0.0,  1.0,
                    1.0,  0.0,
                    1.0,  1.0]), gl.STATIC_DRAW);
                gl.enableVertexAttribArray(positionLocation);
                gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

                //*
                gl.bindTexture(gl.TEXTURE_2D, texture);
                
                // Set the parameters so we can render any size image.
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
                gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

                // Upload the image into the texture.
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
              
                var dstX = 10;
                var dstY = 10;
                var dstWidth = canvas.width;
                var dstHeight = canvas.height;
              
                // convert dst pixel coords to clipspace coords      
                var clipX = dstX / gl.canvas.width  *  2 - 1;
                var clipY = dstY / gl.canvas.height * -2 + 1;
                var clipWidth = dstWidth  / gl.canvas.width  *  2;
                var clipHeight = dstHeight / gl.canvas.height * -2;
              
                // build a matrix that will stretch our
                // unit quad to our desired size and location
                gl.uniformMatrix3fv(u_matrixLoc, false, [
                    clipWidth, 0, 0,
                    0, clipHeight, 0,
                    clipX, clipY, 1,
                ]);
              
                // Draw the rectangle.
                oDrawArrays.call(gl, gl.TRIANGLES, 0, 6);
                //*/
                gl.useProgram(origProgram)
                gl.bindBuffer(gl.ARRAY_BUFFER, origBuffer)
                gl.bindTexture(gl.TEXTURE_2D, origTexture)
            }

            /*
            let newCallbacks = []

            const oRequestAnimationFrame = window.requestAnimationFrame
            window.requestAnimationFrame = callback => {
              newCallbacks.push(callback)
            }

            function onAnimationFrame(timestamp) {
                const currentCallbacks = newCallbacks
                newCallbacks = []
                currentCallbacks.forEach(callback => {
                    callback(timestamp)
                })

                renderMenuCanvas()
                //renderMenuInWebGL(canvas)

                oRequestAnimationFrame(onAnimationFrame)
            }
            onAnimationFrame(onAnimationFrame)
            //*/
            //*


            let windowMousePos = null
            window.addEventListener("mousemove", e => {
                windowMousePos = windowMousePos || {}
                const temp = windowMousePos

                temp.movementX = e.movementX
                temp.movementY = e.movementY
                
                temp.pageX = e.pageX
                temp.pageY = e.pageY

                temp.clientX = e.clientX
                temp.clientY = e.clientY

                temp.layerX = e.layerX
                temp.layerY = e.layerY

                temp.screenX = e.screenX
                temp.screenY = e.screenY
            }, true)

            let canvasMousePos = null
            gl.canvas.addEventListener("mousemove", e => {
                canvasMousePos = canvasMousePos || {}
                const temp = canvasMousePos

                temp.movementX = e.movementX
                temp.movementY = e.movementY
                
                temp.pageX = e.pageX
                temp.pageY = e.pageY

                temp.clientX = e.clientX
                temp.clientY = e.clientY

                temp.layerX = e.layerX
                temp.layerY = e.layerY

                temp.screenX = e.screenX
                temp.screenY = e.screenY
            }, true)

            window.addEventListener("mousedown", e => {
                if (e.button == 1) {
                    options.objAimbot.value = !options.objAimbot.value
                }
            })

            function onAnimationFrame(timestamp) {
                renderMenuCanvas(allEntitiesPos)
                requestAnimationFrame(onAnimationFrame)

                //quad.style.left = (viewport[2] * (pos[0]+1)/2) + "px"
                //quad.style.top =  viewport[3]-(viewport[3] * (pos[1]+1)/2) + "px"

                if (allEntitiesPos.length > 0 && options.objAimbot.value) {
                    let bestFOV = Number.MAX_VALUE
                    let bestPos = null
                    allEntitiesPos.forEach((pos, i) => {
                        const fov = Math.sqrt(pos[0] ** 2 + pos[1] ** 2)
                        if (fov < bestFOV) {
                            bestFOV = fov
                            bestPos = pos
                        }
                    })

                    function moveCursor(x=0, y=0) {
                        function updateXY(temp) {
                            temp.movementX = x
                            temp.movementY = y

                            temp.pageX += x
                            temp.pageY += y
    
                            temp.clientX += x
                            temp.clientY += y
    
                            temp.layerX += x
                            temp.layerY += y
    
                            temp.screenX += x
                            temp.screenY += y
                        }

                        updateXY(windowMousePos)
                        updateXY(canvasMousePos)

                        let ev = new MouseEvent("mousemove", windowMousePos)
                        window.dispatchEvent(ev)

                        ev = new MouseEvent("mousemove", canvasMousePos)
                        gl.canvas.dispatchEvent(ev)
                    }
                    //console.log(bestPos[0], bestPos[1])
                    //console.log(allEntitiesPos)
                    let maxFOV = (options.objAimbotFOV.value) * Math.PI / 180// / bestPos[3]
                    //maxFOV = maxFOV >  (45 * Math.PI / 180) ?  (45 * Math.PI / 180) : maxFOV
                    //maxFOV = maxFOV < -(45 * Math.PI / 180) ? -(45 * Math.PI / 180) : maxFOV
                    if (bestPos && bestFOV <= maxFOV && windowMousePos && canvasMousePos) {

                        let targetX = bestPos[0] * options.objAimbotForce.value * 10
                        //targetX = targetX >  50 ?  50 : targetX
                        //targetX = targetX < -50 ? -50 : targetX

                        let targetY = bestPos[1] * options.objAimbotForce.value * 10
                        //targetY = targetY >  50 ?  50 : targetY
                        //targetY = targetY < -50 ? -50 : targetY
                        //console.log(bestPos[2], bestPos[3])
                        //console.log(targetX, targetY)

                        moveCursor(targetX, -targetY)
                    }
                }
                allEntitiesPos = []
            }
            requestAnimationFrame(onAnimationFrame)
            //*/

            document.addEventListener("keydown", e => {
                if (e.key == "*") {
                    showMenu = !showMenu
                }
                if (!showMenu || !menuIsVisible) return;

                if (e.key == "ArrowUp") {
                    selectedIndex--
                    if (selectedIndex < 0) {
                        selectedIndex = 0
                    }
                    
                    const optName = Object.keys(options)[selectedIndex]
                    if (optName == "objSelector") {
                        isSelectingObject = true
                    } else {
                        isSelectingObject = false
                    }
                } else if (e.key == "ArrowDown") {
                    selectedIndex++
                    const optionsCount = Object.keys(options).length
                    if (selectedIndex > optionsCount - 1) {
                        selectedIndex = optionsCount - 1
                    }

                    const optName = Object.keys(options)[selectedIndex]
                    if (optName == "objSelector") {
                        isSelectingObject = true
                    } else {
                        isSelectingObject = false
                    }
                } else if (e.key == "ArrowLeft" || e.key == "ArrowRight") {
                    const optName = Object.keys(options)[selectedIndex]
                    const optSelected = options[optName]

                    if (optSelected.type == "toggle") {
                        optSelected.value = !optSelected.value
                    }

                    if (optName === "objOutline" && optSelected.value) {
                        options.objChams.value = false
                    }
                    if (optName === "objChams" && optSelected.value) {
                        options.objOutline.value = false
                    }
                }
                if (e.key == "ArrowLeft") {
                    const optName = Object.keys(options)[selectedIndex]
                    const optSelected = options[optName]
                    if (optSelected.type == "range") {
                        optSelected.value--

                        if (optSelected.value < optSelected.min) {
                            optSelected.value = optSelected.min
                        }
                    }
                } else if (e.key == "ArrowRight") {
                    const optName = Object.keys(options)[selectedIndex]
                    const optSelected = options[optName]
                    if (optSelected.type == "range") {
                        optSelected.value++

                        if (optSelected.value > optSelected.max) {
                            optSelected.value = optSelected.max
                        }
                    }
                } else if (e.key == "Insert") {
                    const optName = Object.keys(options)[selectedIndex]
                    const optSelected = options[optName]

                    if (optName == "objSelector") {
                        const objCount = objects[options.objSelector.value-1]
                        if (selectedObjs.indexOf(objCount) === -1 && objCount) {
                            selectedObjs.push(objCount)
                        }
                        console.info(selectedObjs)
                    }
                } else if (e.key == "Delete") {
                    const optName = Object.keys(options)[selectedIndex]
                    const optSelected = options[optName]
                    if (optName == "objSelector") {
                        const objCount = objects[options.objSelector.value-1]
                        const index =  selectedObjs.indexOf(objCount)
                        if (index > -1) {
                            selectedObjs.splice(index, 1)
                        }
                    }
                }
            }, true)
        }
    }
})()
`

const eScript = document.createElement("script")
eScript.textContent = scriptCode
document.documentElement.prepend(eScript)
