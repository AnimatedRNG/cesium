/*global define*/
define([
        '../Core/Color',
        '../Core/ComponentDatatype',
        '../Core/defined',
        '../Core/destroyObject',
        '../Core/Geometry',
        '../Core/GeometryAttribute',
        '../Core/PixelFormat',
        '../Core/PrimitiveType',
        '../Renderer/BufferUsage',
        '../Renderer/ClearCommand',
        '../Renderer/DrawCommand',
        '../Renderer/Framebuffer',
        '../Renderer/Pass',
        '../Renderer/PixelDatatype',
        '../Renderer/RenderState',
        '../Renderer/Sampler',
        '../Renderer/ShaderSource',
        '../Renderer/ShaderProgram',
        '../Renderer/Texture',
        '../Renderer/TextureMagnificationFilter',
        '../Renderer/TextureMinificationFilter',
        '../Renderer/TextureWrap',
        '../Renderer/TimerQuery',
        '../Renderer/VertexArray',
        '../Scene/BlendEquation',
        '../Scene/BlendFunction',
        '../Scene/BlendingState',
        '../Scene/StencilFunction',
        '../Scene/StencilOperation',
        '../Shaders/PostProcessFilters/PointOcclusionPassGL1',
        '../Shaders/PostProcessFilters/PointOcclusionPassGL2',
        '../Shaders/PostProcessFilters/RegionGrowingPassGL1',
        '../Shaders/PostProcessFilters/RegionGrowingPassGL2',
        '../Shaders/PostProcessFilters/DensityEdgeCullPass',
        '../Shaders/PostProcessFilters/PointCloudPostProcessorBlendPass'
    ], function(
        Color,
        ComponentDatatype,
        defined,
        destroyObject,
        Geometry,
        GeometryAttribute,
        PixelFormat,
        PrimitiveType,
        BufferUsage,
        ClearCommand,
        DrawCommand,
        Framebuffer,
        Pass,
        PixelDatatype,
        RenderState,
        Sampler,
        ShaderSource,
        ShaderProgram,
        Texture,
        TextureMagnificationFilter,
        TextureMinificationFilter,
        TextureWrap,
        TimerQuery,
        VertexArray,
        BlendEquation,
        BlendFunction,
        BlendingState,
        StencilFunction,
        StencilOperation,
        PointOcclusionPassGL1,
        PointOcclusionPassGL2,
        RegionGrowingPassGL1,
        RegionGrowingPassGL2,
        DensityEdgeCullPass,
        PointCloudPostProcessorBlendPass
    ) {
    'use strict';

     /**
     * @private
     */
    function PointCloudPostProcessor(options) {
        this._framebuffers = undefined;
        this._colorTextures = undefined;
        this._ecTexture = undefined;
        this._depthTextures = undefined;
        this._densityTexture = undefined;
        this._edgeCullingTexture = undefined;
        this._sectorLUTTexture = undefined;
        this._aoTextures = undefined;
        this._dirty = undefined;
        this._drawCommands = undefined;
        this._clearCommands = undefined;

        this.densityScaleFactor = 10.0;
        this.occlusionAngle = options.occlusionAngle;
        this.rangeParameter = options.rangeParameter;
        this.neighborhoodHalfWidth = options.neighborhoodHalfWidth;
        this.numRegionGrowingPasses = options.numRegionGrowingPasses;
        this.densityHalfWidth = options.densityHalfWidth;
        this.neighborhoodVectorSize = options.neighborhoodVectorSize;
        this.maxAbsRatio = options.maxAbsRatio;
        this.densityViewEnabled = options.densityViewEnabled;
        this.stencilViewEnabled = options.stencilViewEnabled;
        this.pointAttenuationMultiplier = options.pointAttenuationMultiplier;
        this.useTriangle = options.useTriangle;
        this.enableAO = options.enableAO;
        this.AOViewEnabled = options.AOViewEnabled;
        this.depthViewEnabled = options.depthViewEnabled;
        this.sigmoidDomainOffset = options.sigmoidDomainOffset;
        this.sigmoidSharpness = options.sigmoidSharpness;
        this.useTimerQuery  = options.useTimerQuery;
        this.dropoutFactor = options.dropoutFactor;
        this.delay = options.delay;

        this._pointArray = undefined;

        this._minBlend = {
            enabled : true,
            equationRgb : BlendEquation.MIN,
            equationAlpha : BlendEquation.MIN,
            functionSourceRgb : BlendFunction.ONE,
            functionSourceAlpha : BlendFunction.ONE,
            functionDestinationRgb : BlendFunction.ONE,
            functionDestinationAlpha : BlendFunction.ONE
        };
        this._addBlend = {
            enabled : true,
            equationRgb : BlendEquation.ADD,
            equationAlpha : BlendEquation.ADD,
            functionSourceRgb : BlendFunction.ONE,
            functionSourceAlpha : BlendFunction.ONE,
            functionDestinationRgb : BlendFunction.ONE,
            functionDestinationAlpha : BlendFunction.ONE
        };

        this._testingFunc = StencilFunction.EQUAL;
        this._testingOp = {
            fail : StencilOperation.KEEP,
            zFail : StencilOperation.KEEP,
            zPass : StencilOperation.KEEP
        };
        this._writeFunc = StencilFunction.ALWAYS;
        this._writeOp = {
            fail : StencilOperation.KEEP,
            zFail : StencilOperation.KEEP,
            zPass : StencilOperation.ZERO
        };

        this._positiveStencilTest = {
            enabled : true,
            reference : 0,
            mask : 1,
            frontFunction : this._testingFunc,
            backFunction : this._testingFunc,
            frontOperation : this._testingOp,
            backOperation : this._testingOp
        };
        this._negativeStencilTest = {
            enabled : true,
            reference : 1,
            mask : 1,
            frontFunction : this._testingFunc,
            backFunction : this._testingFunc,
            frontOperation : this._testingOp,
            backOperation : this._testingOp
        };
        this._stencilWrite = {
            enabled : true,
            reference : 1,
            mask : 0,
            frontFunction : this._writeFunc,
            backFunction : this._writeFunc,
            frontOperation : this._writeOp,
            backOperation : this._writeOp
        };

        this.rangeMin = 1e-6;
        this.rangeMax = 5e-2;
    }

    function createSampler() {
        return new Sampler({
            wrapS : TextureWrap.CLAMP_TO_EDGE,
            wrapT : TextureWrap.CLAMP_TO_EDGE,
            minificationFilter : TextureMinificationFilter.NEAREST,
            magnificationFilter : TextureMagnificationFilter.NEAREST
        });
    }

    function destroyFramebuffers(processor) {
        processor._depthTextures[0].destroy();
        processor._depthTextures[1].destroy();
        processor._ecTexture.destroy();
        processor._sectorLUTTexture.destroy();
        processor._aoTextures[0].destroy();
        processor._aoTextures[1].destroy();
        processor._densityTexture.destroy();
        processor._edgeCullingTexture.destroy();
        processor._dirty.destroy();
        processor._colorTextures[0].destroy();
        processor._colorTextures[1].destroy();
        var framebuffers = processor._framebuffers;
        for (var name in framebuffers) {
            if (framebuffers.hasOwnProperty(name)) {
                framebuffers[name].destroy();
            }
        }

        processor._framebuffers = undefined;
        processor._colorTextures = undefined;
        processor._ecTexture = undefined;
        processor._depthTextures = undefined;
        processor._densityTexture = undefined;
        processor._edgeCullingTexture = undefined;
        processor._sectorLUTTexture = undefined;
        processor._aoTextures = undefined;
        processor._dirty = undefined;
        processor._drawCommands = undefined;
    }

    function generateSectorLUT(processor) {
        function getSector(dx, dy, numSectors) {
            var angle = (Math.atan2(dy, dx) + Math.PI) / (2.0 * Math.PI) - 1e-6;
            return Math.trunc(angle * numSectors);
        }

        function collapseSectors(dx, dy, numSectors) {
            var sectors = new Uint8Array(4);
            sectors[0] = getSector(dx - 0.5, dy + 0.5, numSectors);
            sectors[1] = getSector(dx + 0.5, dy - 0.5, numSectors);
            sectors[2] = getSector(dx + 0.5, dy + 0.5, numSectors);
            sectors[3] = getSector(dx - 0.5, dy - 0.5, numSectors);

            var first = sectors[0];
            var second = sectors[0];
            sectors.forEach(function(element) {
                if (element !== first) {
                    second = element;
                }
            });
            return new Array(first, second);
        }

        var numSectors = 8;
        var lutSize = processor.neighborhoodHalfWidth * 2 + 1;
        var lut = new Uint8Array(lutSize * lutSize * 4);
        var start = -Math.trunc(lutSize / 2);
        var end = -start;
        for (var i = start; i <= end; i++) {
            for (var j = start; j <= end; j++) {
                var offset = ((i + end) + (j + end) * lutSize) * 4;
                var sectors = collapseSectors(i, j, numSectors);
                lut[offset] = Math.trunc(256 * (sectors[0] / 8));
                lut[offset + 1] = Math.trunc(256 * (sectors[1] / 8));
            }
        }

        return lut;
    }

    function createFramebuffers(processor, context) {
        var i;
        var screenWidth = context.drawingBufferWidth;
        var screenHeight = context.drawingBufferHeight;

        var colorTextures = new Array(2);
        var depthTextures = new Array(3);
        var aoTextures = new Array(2);

        var ecTexture = new Texture({
            context : context,
            width : screenWidth,
            height : screenHeight,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.FLOAT,
            sampler : createSampler()
        });

        var densityMap = new Texture({
            context : context,
            width : screenWidth,
            height : screenHeight,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
            sampler : createSampler()
        });

        var edgeCullingTexture = new Texture({
            context : context,
            width : screenWidth,
            height : screenHeight,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.FLOAT,
            sampler : createSampler()
        });

        // Load the sector LUT that the point occlusion pass needs
        var lutSize = processor.neighborhoodHalfWidth * 2 + 1;
        var sectorLUTTexture = new Texture({
            context : context,
            width : lutSize,
            height : lutSize,
            pixelFormat : PixelFormat.RGBA,
            pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
            sampler : createSampler()
        });
        var lutData = generateSectorLUT(processor);
        sectorLUTTexture.copyFrom({
            width : lutSize,
            height : lutSize,
            arrayBufferView : lutData
        });

        var dirty = new Texture({
            context: context,
            width: screenWidth,
            height: screenHeight,
            pixelFormat: PixelFormat.DEPTH_STENCIL,
            pixelDatatype: PixelDatatype.UNSIGNED_INT_24_8,
            sampler: createSampler()
        });

        for (i = 0; i < 2; ++i) {
            colorTextures[i] = new Texture({
                context : context,
                width : screenWidth,
                height : screenHeight,
                pixelFormat : PixelFormat.RGBA,
                pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
                sampler : createSampler()
            });

            depthTextures[i] = new Texture({
                context : context,
                width : screenWidth,
                height : screenHeight,
                pixelFormat : PixelFormat.RGBA,
                pixelDatatype : PixelDatatype.FLOAT,
                sampler : createSampler()
            });

            aoTextures[i] = new Texture({
                context : context,
                width : screenWidth,
                height : screenHeight,
                pixelFormat : PixelFormat.RGBA,
                pixelDatatype : PixelDatatype.UNSIGNED_BYTE,
                sampler : createSampler()
            });
        }

        // There used to be an explanation of how this worked here
        // but it got too long.
        // TODO: Find a better place to put an explanation of what all
        // the framebuffers are meant for.
        processor._framebuffers = {
            prior : new Framebuffer({
                context : context,
                colorTextures : [
                    colorTextures[0],
                    ecTexture
                ],
                depthStencilTexture : dirty,
                destroyAttachments : false
            }),
            screenSpacePass : new Framebuffer({
                context : context,
                colorTextures : [depthTextures[0], aoTextures[0]],
                depthStencilTexture: dirty,
                destroyAttachments : false
            }),
            aoBufferA : new Framebuffer({
                context : context,
                colorTextures : [aoTextures[1]],
                destroyAttachments : false
            }),
            aoBufferB : new Framebuffer({
                context : context,
                colorTextures : [aoTextures[0]],
                destroyAttachments : false
            }),
            stencilMask : new Framebuffer({
                context : context,
                depthStencilTexture: dirty,
                destroyAttachments : false
            }),
            densityEstimationPass : new Framebuffer({
                context : context,
                colorTextures : [densityMap],
                depthStencilTexture: dirty,
                destroyAttachments : false
            }),
            regionGrowingPassA : new Framebuffer({
                context : context,
                colorTextures : [colorTextures[1],
                                 depthTextures[1],
                                 aoTextures[1]],
                depthStencilTexture: dirty,
                destroyAttachments : false
            }),
            regionGrowingPassB : new Framebuffer({
                context: context,
                colorTextures: [colorTextures[0],
                                depthTextures[0],
                                aoTextures[0]],
                depthStencilTexture: dirty,
                destroyAttachments: false
            })
        };
        processor._depthTextures = depthTextures;
        processor._densityTexture = densityMap;
        processor._edgeCullingTexture = edgeCullingTexture;
        processor._sectorLUTTexture = sectorLUTTexture;
        processor._aoTextures = aoTextures;
        processor._colorTextures = colorTextures;
        processor._ecTexture = ecTexture;
        processor._dirty = dirty;
    }

    function replaceConstants(sourceStr, constantName, replacement) {
        var r;
        if (typeof(replacement) === 'boolean') {
            if (replacement === false) {
                r = '#define\\s' + constantName;
                return sourceStr.replace(new RegExp(r, 'g'), '/*#define ' + constantName + '*/');
            }
                return sourceStr;
        }
        r = '#define\\s' + constantName + '\\s([0-9.]+)';
        return sourceStr.replace(new RegExp(r, 'g'), '#define ' + constantName + ' ' + replacement);
    }

     function pointOcclusionStage(processor, context) {
        var uniformMap = {
            sectorLUT : function() {
                return processor._sectorLUTTexture;
            },
            pointCloud_ECTexture : function() {
                return processor._ecTexture;
            },
            occlusionAngle : function() {
                return processor.occlusionAngle;
            },
            dropoutFactor : function() {
                return processor.dropoutFactor;
            }
        };

        var pointOcclusionStr = replaceConstants(
            (context.webgl2) ? PointOcclusionPassGL2 : PointOcclusionPassGL1,
            'neighborhoodHalfWidth',
            processor.neighborhoodHalfWidth
        );

        pointOcclusionStr = replaceConstants(
            pointOcclusionStr,
            'useTriangle',
            processor.useTriangle
        );

        if (processor.dropoutFactor < 1e-6) {
            pointOcclusionStr = replaceConstants(
                pointOcclusionStr,
                'dropoutEnabled',
                false);
        }

        return context.createViewportQuadCommand(pointOcclusionStr, {
            uniformMap : uniformMap,
            framebuffer : processor._framebuffers.screenSpacePass,
            renderState : RenderState.fromCache({
                stencilTest : processor._positiveStencilTest
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function densityEdgeCullStage(processor, context) {
        var uniformMap = {
            pointCloud_depthTexture : function() {
                return processor._depthTextures[0];
            },
            neighborhoodVectorSize : function() {
                return processor.neighborhoodVectorSize;
            },
            maxAbsRatio : function() {
                return processor.maxAbsRatio;
            },
            dropoutFactor : function() {
                return processor.dropoutFactor;
            }
        };

        var densityEdgeCullStr = replaceConstants(
            DensityEdgeCullPass,
            'neighborhoodHalfWidth',
            processor.densityHalfWidth
        );

        if (processor.dropoutFactor < 1e-6 || !context.webgl2) {
            densityEdgeCullStr = replaceConstants(
                densityEdgeCullStr,
                'dropoutEnabled',
                false);
        }

        return context.createViewportQuadCommand(densityEdgeCullStr, {
            uniformMap : uniformMap,
            framebuffer : processor._framebuffers.densityEstimationPass,
            renderState : RenderState.fromCache({
                stencilTest : processor._negativeStencilTest
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function regionGrowingStage(processor, context, iteration) {
        var i = iteration % 2;
        var rangeMin = processor.rangeMin;
        var rangeMax = processor.rangeMax;

        var uniformMap = {
            pointCloud_colorTexture : function() {
                return processor._colorTextures[i];
            },
            pointCloud_depthTexture : function() {
                return processor._depthTextures[i];
            },
            pointCloud_densityTexture : function() {
                return processor._densityTexture;
            },
            pointCloud_aoTexture : function() {
                return processor._aoTextures[i];
            },
            rangeParameter : function() {
                if (processor.useTriangle) {
                    return processor.rangeParameter;
                }
                if (processor.rangeParameter < rangeMin) {
                    return 0.0;
                }
                return processor.rangeParameter * (rangeMax - rangeMin) + rangeMin;
            },
            densityHalfWidth : function() {
                return processor.densityHalfWidth;
            },
            iterationNumber : function() {
                return iteration;
            }
        };

        var framebuffer = (i === 0) ?
            processor._framebuffers.regionGrowingPassA :
            processor._framebuffers.regionGrowingPassB;

        var regionGrowingPassStr = (context.webgl2) ?
            RegionGrowingPassGL2 :
            RegionGrowingPassGL1;

        regionGrowingPassStr = replaceConstants(
            regionGrowingPassStr,
            'densityView',
            processor.densityViewEnabled
        );

        regionGrowingPassStr = replaceConstants(
            regionGrowingPassStr,
            'stencilView',
            processor.stencilViewEnabled
        );

        regionGrowingPassStr = replaceConstants(
            regionGrowingPassStr,
            'DELAY',
            processor.delay
        );

        return context.createViewportQuadCommand(regionGrowingPassStr, {
            uniformMap : uniformMap,
            framebuffer : framebuffer,
            renderState : RenderState.fromCache({
                stencilTest : processor._positiveStencilTest
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function copyRegionGrowingColorStage(processor, context, i) {
        var uniformMap = {
            pointCloud_colorTexture : function() {
                return processor._colorTextures[i];
            },
            pointCloud_depthTexture : function() {
                return processor._depthTextures[i];
            },
            pointCloud_aoTexture : function() {
                return processor._aoTextures[i];
            },
            pointCloud_densityTexture : function() {
                return processor._densityTexture;
            },
            densityHalfWidth : function() {
                return processor.densityHalfWidth;
            }
        };

        var framebuffer = (i === 0) ?
            processor._framebuffers.regionGrowingPassA :
            processor._framebuffers.regionGrowingPassB;

        var copyStageStr =
            '#extension GL_EXT_draw_buffers : enable \n' +
            '#define densityView \n' +
            '#define densityScaleFactor 10.0 \n' +
            '#define EPS 1e-6 \n' +
            'uniform int densityHalfWidth; \n' +
            'uniform sampler2D pointCloud_colorTexture; \n' +
            'uniform sampler2D pointCloud_depthTexture; \n' +
            'uniform sampler2D pointCloud_aoTexture; \n' +
            'uniform sampler2D pointCloud_densityTexture; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main() \n' +
            '{ \n' +
            '    vec4 depth = texture2D(pointCloud_depthTexture, v_textureCoordinates); \n' +
            '    vec4 rawAO = texture2D(pointCloud_aoTexture, v_textureCoordinates); \n' +
            '    if (length(depth) > EPS) { \n' +
            '        #ifdef densityView \n' +
            '        float density = ceil(densityScaleFactor * texture2D(pointCloud_densityTexture, v_textureCoordinates).r); \n' +
            '        gl_FragData[0] = vec4(vec3(density / float(densityHalfWidth)), 1.0); \n' +
            '        #else \n' +
            '        gl_FragData[0] = texture2D(pointCloud_colorTexture, v_textureCoordinates); \n' +
            '        #endif \n' +
            '        gl_FragData[1] = depth; \n' +
            '        gl_FragData[2] = rawAO; \n' +
            '    }  else { \n' +
            '       gl_FragData[1] = vec4(0.0); ' +
            '       gl_FragData[2] = czm_packDepth(1.0 - EPS); ' +
            '    } \n' +
            '} \n';

        copyStageStr = replaceConstants(
            copyStageStr,
            'densityView',
            processor.densityViewEnabled
        );

        return context.createViewportQuadCommand(copyStageStr, {
            uniformMap : uniformMap,
            framebuffer : framebuffer,
            renderState : RenderState.fromCache({
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function stencilMaskStage(processor, context, iteration) {
        var uniformMap = {
            pointCloud_densityTexture : function() {
                return processor._densityTexture;
            }
        };

        var stencilMaskStageStr =
            '#define EPS 1e-8 \n' +
            '#define cutoff 0 \n' +
            '#define DELAY 1 \n' +
            '#define densityScaleFactor 10.0 \n' +
            'uniform sampler2D pointCloud_densityTexture; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main() \n' +
            '{ \n' +
            '    float density = ceil(densityScaleFactor * texture2D(pointCloud_densityTexture, v_textureCoordinates).r); \n' +
            '    if (float(cutoff - DELAY) + EPS > density) \n' +
            '        discard; \n' +
            '} \n';

        stencilMaskStageStr = replaceConstants(
            stencilMaskStageStr,
            'cutoff',
            iteration
        );

        stencilMaskStageStr = replaceConstants(
            stencilMaskStageStr,
            'DELAY',
            processor.delay
        );

        var framebuffer = processor._framebuffers.stencilMask;

        return context.createViewportQuadCommand(stencilMaskStageStr, {
            uniformMap : uniformMap,
            framebuffer : framebuffer,
            renderState : RenderState.fromCache({
                stencilTest : processor._stencilWrite
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function debugViewStage(processor, context, texture, unpack) {
        var uniformMap = {
            debugTexture : function() {
                return texture;
            }
        };

        var debugViewStageStr =
            '#define EPS 1e-8 \n' +
            '#define unpack \n' +
            'uniform sampler2D debugTexture; \n' +
            'varying vec2 v_textureCoordinates; \n' +
            'void main() \n' +
            '{ \n' +
            '    vec4 value = texture2D(debugTexture, v_textureCoordinates); \n' +
            '#ifdef unpack \n' +
            '    value = vec4(czm_unpackDepth(value)); \n' +
            '#endif // unpack \n' +
            '    gl_FragColor = vec4(value); \n' +
            '} \n';

        debugViewStageStr = replaceConstants(
            debugViewStageStr,
            'unpack',
            unpack
        );

        return context.createViewportQuadCommand(debugViewStageStr, {
            uniformMap : uniformMap,
            renderState : RenderState.fromCache({
            }),
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });
    }

    function createCommands(processor, context) {
        processor._drawCommands = {};
        var numRegionGrowingPasses = processor.numRegionGrowingPasses;
        var regionGrowingCommands = new Array(numRegionGrowingPasses);
        var stencilCommands = new Array(numRegionGrowingPasses);
        var copyCommands = new Array(2);

        var i;
        processor._drawCommands.densityEdgeCullCommand = densityEdgeCullStage(processor, context);
        processor._drawCommands.pointOcclusionCommand = pointOcclusionStage(processor, context);

        for (i = 0; i < numRegionGrowingPasses; i++) {
            regionGrowingCommands[i] = regionGrowingStage(processor, context, i);
            stencilCommands[i] = stencilMaskStage(processor, context, i);
        }

        copyCommands[0] = copyRegionGrowingColorStage(processor, context, 0);
        copyCommands[1] = copyRegionGrowingColorStage(processor, context, 1);

        var blendRenderState;
        if (processor.useTriangle) {
            blendRenderState = RenderState.fromCache({
                blending : BlendingState.ALPHA_BLEND
            });
        } else {
            blendRenderState = RenderState.fromCache({
                blending : BlendingState.ALPHA_BLEND,
                depthMask : true,
                depthTest : {
                    enabled : true
                }
            });
        }

        var blendFS = replaceConstants(
            PointCloudPostProcessorBlendPass,
            'enableAO',
            processor.enableAO && !processor.densityViewEnabled && !processor.stencilViewEnabled
        );

        var blendUniformMap = {
            pointCloud_colorTexture : function() {
                return processor._colorTextures[1 - numRegionGrowingPasses % 2];
            },
            pointCloud_depthTexture : function() {
                return processor._depthTextures[1 - numRegionGrowingPasses % 2];
            },
            pointCloud_aoTexture : function() {
                return processor._aoTextures[1 - numRegionGrowingPasses % 2];
            },
            sigmoidDomainOffset : function() {
                return processor.sigmoidDomainOffset;
            },
            sigmoidSharpness : function() {
                return processor.sigmoidSharpness;
            }
        };

        var blendCommand = context.createViewportQuadCommand(blendFS, {
            uniformMap : blendUniformMap,
            renderState : blendRenderState,
            pass : Pass.CESIUM_3D_TILE,
            owner : processor
        });

        var debugViewCommand;
        if (processor.AOViewEnabled) {
            debugViewCommand = debugViewStage(processor, context, processor._aoTextures[0], true);
        } else if (processor.depthViewEnabled) {
            debugViewCommand = debugViewStage(processor, context, processor._depthTextures[0], false);
        }

        var framebuffers = processor._framebuffers;
        var clearCommands = {};
        for (var name in framebuffers) {
            if (framebuffers.hasOwnProperty(name)) {
                // The screen space pass should consider
                // the stencil value, so we don't clear it
                // here. 1.0 / densityScale is the base density
                // for invalid pixels, so we clear to that.
                // Also we want to clear the AO buffer to white
                // so that the pixels that never get region-grown
                // do not appear black
                if (name === 'screenSpacePass') {
                    clearCommands[name] = new ClearCommand({
                        framebuffer : framebuffers[name],
                        color : new Color(0.0, 0.0, 0.0, 0.0),
                        depth : 1.0,
                        renderState : RenderState.fromCache(),
                        pass : Pass.CESIUM_3D_TILE,
                        owner : processor
                    });
                } else if (name === 'densityEstimationPass') {
                    clearCommands[name] = new ClearCommand({
                        framebuffer : framebuffers[name],
                        color : new Color(1.0 / processor.densityScaleFactor, 0.0, 0.0, 0.0),
                        depth : 1.0,
                        renderState : RenderState.fromCache(),
                        pass : Pass.CESIUM_3D_TILE,
                        owner : processor
                    });
                } else if (name === 'aoBufferA' ||
                           name === 'aoBufferB') {
                    clearCommands[name] = new ClearCommand({
                        framebuffer : framebuffers[name],
                        color : new Color(1.0, 1.0, 1.0, 1.0),
                        depth : 1.0,
                        renderState : RenderState.fromCache(),
                        pass : Pass.CESIUM_3D_TILE,
                        owner : processor
                    });
                } else {
                    clearCommands[name] = new ClearCommand({
                        framebuffer : framebuffers[name],
                        color : new Color(0.0, 0.0, 0.0, 0.0),
                        depth : 1.0,
                        stencil : 1.0,
                        renderState : RenderState.fromCache(),
                        pass : Pass.CESIUM_3D_TILE,
                        owner : processor
                    });
                }
            }
        }
        processor._drawCommands.regionGrowingCommands = regionGrowingCommands;
        processor._drawCommands.stencilCommands = stencilCommands;
        processor._drawCommands.blendCommand = blendCommand;
        processor._drawCommands.copyCommands = copyCommands;
        processor._drawCommands.debugViewCommand = debugViewCommand;
        processor._clearCommands = clearCommands;
    }

    function createResources(processor, context, dirty) {
        var screenWidth = context.drawingBufferWidth;
        var screenHeight = context.drawingBufferHeight;
        var colorTextures = processor._colorTextures;
        var regionGrowingCommands = (defined(processor._drawCommands)) ? processor._drawCommands.regionGrowingCommands : undefined;
        var stencilCommands = (defined(processor._drawCommands)) ? processor._drawCommands.stencilCommands : undefined;
        var nowDirty = false;
        var resized = defined(colorTextures) &&
            ((colorTextures[0].width !== screenWidth) ||
             (colorTextures[0].height !== screenHeight));

        if (!defined(colorTextures)) {
            createFramebuffers(processor, context);
            nowDirty = true;
        }

        if (!defined(regionGrowingCommands) || !defined(stencilCommands) || dirty) {
            createCommands(processor, context);
        }

        if (resized) {
            destroyFramebuffers(processor);
            createFramebuffers(processor, context);
            createCommands(processor, context);
            nowDirty = true;
        }
        return nowDirty;
    }

    function processingSupported(context) {
        return context.depthTexture && context.blendMinmax;
    }

    function getECShaderProgram(context, shaderProgram) {
        var shader = context.shaderCache.getDerivedShaderProgram(shaderProgram, 'EC');
        if (!defined(shader)) {
            var attributeLocations = shaderProgram._attributeLocations;

            var vs = shaderProgram.vertexShaderSource.clone();
            var fs = shaderProgram.fragmentShaderSource.clone();

            vs.sources = vs.sources.map(function(source) {
                source = ShaderSource.replaceMain(source, 'czm_point_cloud_post_process_main');
                return source;
            });

            fs.sources = fs.sources.map(function(source) {
                source = ShaderSource.replaceMain(source, 'czm_point_cloud_post_process_main');
                source = source.replace(/gl_FragColor/g, 'gl_FragData[0]');
                return source;
            });

            vs.sources.push(
                'varying vec3 v_positionECPS; \n' +
                'void main() \n' +
                '{ \n' +
                '    czm_point_cloud_post_process_main(); \n' +
                '    v_positionECPS = (czm_inverseProjection * gl_Position).xyz; \n' +
                '}');
            fs.sources.splice(0, 0,
                              '#extension GL_EXT_draw_buffers : enable \n');
            fs.sources.push(
                'varying vec3 v_positionECPS; \n' +
                'void main() \n' +
                '{ \n' +
                '    czm_point_cloud_post_process_main(); \n' +
                '    gl_FragData[1] = vec4(v_positionECPS, 0); \n' +
                '}');

            shader = context.shaderCache.createDerivedShaderProgram(shaderProgram, 'EC', {
                vertexShaderSource : vs,
                fragmentShaderSource : fs,
                attributeLocations : attributeLocations
            });
        }

        return shader;
    }

    function updateTimerQueries(processor, frameState) {
        function makeTimerQuery(commandToModifyName) {
            return new TimerQuery(frameState, function (timeElapsed) {
                console.log(commandToModifyName + ': ' + timeElapsed);
            });
        }

        var commands = processor._drawCommands;
        for (var commandName in commands) {
            if (commands.hasOwnProperty(commandName)) {
                var commandsMember = commands[commandName];
                if (commandsMember.constructor === Array) {
                    var numCommands = commandsMember.length;
                    for (var i = 0; i < numCommands; i++) {
                        processor._drawCommands[commandName][i].timerQuery = makeTimerQuery(commandName + ' ' + i);
                    }
                } else {
                    processor._drawCommands[commandName].timerQuery = makeTimerQuery(commandName);
                }
            }
        }
    }

    PointCloudPostProcessor.prototype.update = function(frameState, commandStart, tileset) {
        if (!processingSupported(frameState.context)) {
            return;
        }

        var dirty = false;
        // Set options here
        if (tileset.pointCloudPostProcessorOptions.occlusionAngle !== this.occlusionAngle ||
            tileset.pointCloudPostProcessorOptions.rangeParameter !== this.rangeParameter ||
            tileset.pointCloudPostProcessorOptions.neighborhoodHalfWidth !== this.neighborhoodHalfWidth ||
            tileset.pointCloudPostProcessorOptions.numRegionGrowingPasses !== this.numRegionGrowingPasses ||
            tileset.pointCloudPostProcessorOptions.densityHalfWidth !== this.densityHalfWidth ||
            tileset.pointCloudPostProcessorOptions.neighborhoodVectorSize !== this.neighborhoodVectorSize ||
            tileset.pointCloudPostProcessorOptions.maxAbsRatio !== this.maxAbsRatio ||
            tileset.pointCloudPostProcessorOptions.densityViewEnabled !== this.densityViewEnabled ||
            tileset.pointCloudPostProcessorOptions.depthViewEnabled !== this.depthViewEnabled ||
            tileset.pointCloudPostProcessorOptions.stencilViewEnabled !== this.stencilViewEnabled ||
            tileset.pointCloudPostProcessorOptions.pointAttenuationMultiplier !== this.pointAttenuationMultiplier ||
            tileset.pointCloudPostProcessorOptions.useTriangle !== this.useTriangle ||
            tileset.pointCloudPostProcessorOptions.enableAO !== this.enableAO ||
            tileset.pointCloudPostProcessorOptions.AOViewEnabled !== this.AOViewEnabled ||
            tileset.pointCloudPostProcessorOptions.sigmoidDomainOffset !== this.sigmoidDomainOffset ||
            tileset.pointCloudPostProcessorOptions.useTimerQuery !== this.useTimerQuery ||
            tileset.pointCloudPostProcessorOptions.sigmoidSharpness !== this.sigmoidSharpness ||
            tileset.pointCloudPostProcessorOptions.dropoutFactor !== this.dropoutFactor ||
            tileset.pointCloudPostProcessorOptions.delay !== this.delay) {
            this.occlusionAngle = tileset.pointCloudPostProcessorOptions.occlusionAngle;
            this.rangeParameter = tileset.pointCloudPostProcessorOptions.rangeParameter;
            this.neighborhoodHalfWidth = tileset.pointCloudPostProcessorOptions.neighborhoodHalfWidth;
            this.numRegionGrowingPasses = tileset.pointCloudPostProcessorOptions.numRegionGrowingPasses;
            this.densityHalfWidth = tileset.pointCloudPostProcessorOptions.densityHalfWidth;
            this.neighborhoodVectorSize = tileset.pointCloudPostProcessorOptions.neighborhoodVectorSize;
            this.densityViewEnabled = tileset.pointCloudPostProcessorOptions.densityViewEnabled;
            this.depthViewEnabled = tileset.pointCloudPostProcessorOptions.depthViewEnabled;
            this.stencilViewEnabled = tileset.pointCloudPostProcessorOptions.stencilViewEnabled;
            this.maxAbsRatio = tileset.pointCloudPostProcessorOptions.maxAbsRatio;
            this.pointAttenuationMultiplier = tileset.pointCloudPostProcessorOptions.pointAttenuationMultiplier;
            this.useTriangle = tileset.pointCloudPostProcessorOptions.useTriangle;
            this.enableAO = tileset.pointCloudPostProcessorOptions.enableAO;
            this.AOViewEnabled = tileset.pointCloudPostProcessorOptions.AOViewEnabled;
            this.sigmoidDomainOffset = tileset.pointCloudPostProcessorOptions.sigmoidDomainOffset;
            this.sigmoidSharpness = tileset.pointCloudPostProcessorOptions.sigmoidSharpness;
            this.useTimerQuery = tileset.pointCloudPostProcessorOptions.useTimerQuery;
            this.dropoutFactor = tileset.pointCloudPostProcessorOptions.dropoutFactor;
            this.delay = tileset.pointCloudPostProcessorOptions.delay;
            dirty = true;
        }

        if (!tileset.pointCloudPostProcessorOptions.enabled) {
            return;
        }

        dirty |= createResources(this, frameState.context, dirty);

        // Render point cloud commands into an offscreen FBO.
        var i;
        var commandList = frameState.commandList;
        var commandEnd = commandList.length;

        var attenuationMultiplier = this.pointAttenuationMultiplier;
        var attenuationUniformFunction = function() {
            return attenuationMultiplier;
        };

        function createTimerQuery(str) {
            return new TimerQuery(frameState, function (timeElapsed) {
                console.log(str + ': ' + timeElapsed);
            });
        }

        // Change so that this actually injects into prior commands!
        for (i = commandStart; i < commandEnd; ++i) {
            var command = commandList[i];
            if (command.primitiveType !== PrimitiveType.POINTS) {
                continue;
            }

            var derivedCommand = command.derivedCommands.pointCloudProcessor;
            if (!defined(derivedCommand) || command.dirty || dirty) {
                derivedCommand = DrawCommand.shallowClone(command);
                command.derivedCommands.pointCloudProcessor = derivedCommand;

                derivedCommand.framebuffer = this._framebuffers.prior;
                derivedCommand.shaderProgram = getECShaderProgram(frameState.context, command.shaderProgram);
                derivedCommand.castShadows = false;
                derivedCommand.receiveShadows = false;

                var derivedCommandRenderState = derivedCommand.renderState;
                derivedCommandRenderState.stencilTest = this._stencilWrite;
                derivedCommand.renderState = RenderState.fromCache(
                    derivedCommandRenderState
                );

                // TODO: Even if the filter is disabled,
                // point attenuation settings are not! Fix this behavior.
                var derivedCommandUniformMap = derivedCommand.uniformMap;
                derivedCommandUniformMap['u_pointAttenuationMaxSize'] = attenuationUniformFunction;
                derivedCommand.uniformMap = derivedCommandUniformMap;

                if (this.useTimerQuery) {
                    var priorQuery = createTimerQuery('prior command ' + i);
                    derivedCommand.timerQuery = priorQuery;
                }

                derivedCommand.pass = Pass.CESIUM_3D_TILE; // Overrides translucent commands
                command.dirty = false;
            }

            commandList[i] = derivedCommand;
        }

        if (this.useTimerQuery) {
            updateTimerQueries(this, frameState);
        }

        // Apply processing commands
        var densityEdgeCullCommand = this._drawCommands.densityEdgeCullCommand;
        var pointOcclusionCommand = this._drawCommands.pointOcclusionCommand;
        var regionGrowingCommands = this._drawCommands.regionGrowingCommands;
        var copyCommands = this._drawCommands.copyCommands;
        var stencilCommands = this._drawCommands.stencilCommands;
        var clearCommands = this._clearCommands;
        var blendCommand = this._drawCommands.blendCommand;
        var debugViewCommand = this._drawCommands.debugViewCommand;
        var numRegionGrowingCommands = regionGrowingCommands.length;

        if (this.useTimerQuery) {
            var startOfFrame = new TimerQuery(frameState, function (timeElapsed) {
                console.log('\n\n\nNew Frame:');
            });
            startOfFrame.begin();
            startOfFrame.end();
        }

        commandList.push(clearCommands['screenSpacePass']);
        commandList.push(clearCommands['aoBufferB']);
        commandList.push(pointOcclusionCommand);
        commandList.push(clearCommands['densityEstimationPass']);
        commandList.push(densityEdgeCullCommand);

        for (i = 0; i < numRegionGrowingCommands; i++) {
            if (i % 2 === 0) {
                commandList.push(clearCommands['regionGrowingPassA']);
                commandList.push(clearCommands['aoBufferA']);
            } else {
                commandList.push(clearCommands['regionGrowingPassB']);
                commandList.push(clearCommands['aoBufferB']);
            }

            commandList.push(copyCommands[i % 2]);
            commandList.push(stencilCommands[i]);
            commandList.push(regionGrowingCommands[i]);
        }

        // Blend final result back into the main FBO
        commandList.push(blendCommand);
        if ((this.AOViewEnabled && this.enableAO) || this.depthViewEnabled) {
            commandList.push(debugViewCommand);
        }

        commandList.push(clearCommands['prior']);
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    PointCloudPostProcessor.prototype.isDestroyed = function() {
        return false;
    };

    /**
     * Part of the {@link Cesium3DTileContent} interface.
     */
    PointCloudPostProcessor.prototype.destroy = function() {
        // TODO: actually destroy stuff
        return destroyObject(this);
    };

    return PointCloudPostProcessor;
});
