/**
 * IMAGE-TO-3D
 WORLD AGENT SKILL PAYLOAD (v2.0.0)
 * Memory-Centered Ultra-Dense TypeScript Payload for AI Agent Skill Generation
 * Enhanced with World Labs Orchestrator Integration & Structural Conditioning
 * 
 * Sources Grounding:
 * - "Image to 3D World Workflow" (World Labs Marble-1.1 / Atlas Pipeline)
 * - "How to Create a Game-Ready 3D Asset for Unreal Engine & Unity"
 *
 * @version 2.0.0
 * @target AI Agent Frameworks (Claude Code, Cursor, Windsurf, LangChain, AutoGen)
 */

export interface AgentToolRequirement {
  toolName: string;
  category: 'VISION_LLM' | 'INPAINTING_EDIT' | 'MESH_3D_GEN' | 'GAUSSIAN_SPLATTING' | 'PHYSICS_COLLIDER' | 'ENGINE_EXPORT' | 'STRUCTURAL_CONDITIONING';
  recommendedModels: string[];
  purpose: string;
}

export interface WorldLabsApiConfig {
  endpoint: 'marble-1.1' | 'atlas';
  structuralConditioning: {
    enabled: boolean;
    referenceFormat: 'Aleph .glbg | 'Depth Mesh' | 'Point Cloud';
    parameterName: 'structural_reference' | 'structural_conditioning_glb';
    geographicAlignment: boolean;
    photorealismBoost: boolean;
  };
}

export interface PipelineStage {
  stageId: number;
  stageName: string;
  description: string;
  inputArtifacts: string[];
  outputArtifacts: string[];
  orchestratorAgentRole: string;
  executingTools: string[];
  promptTemplate: string;
  apiPayloadTemplate?: Record<string, any>;
  qualityGates: string[];
  errorHandling: string;
}

export interface GameReadyOptimizationSpec {
  uvUnwrappingStrategy: string;
  textureBakingMaps: string[];
  polygonBudget: Record<string, number>;
  supportedExportFormats: string[];
  targetEngineEnvironments: string[];
}

export interface ImageTo3DWorldAgentSkill {
  skillMetadata: {
    skillName: string;
    description: string;
    version: string;
    primaryLLMOrchestrator: string;
    worldLabsApiIntegration: WorldLabsApiConfig;
    referenceImplementations: string[];
  };
  requiredToolEcosystem: AgentToolRequirement[];
  pipelineStages: PipelineStage[];
  gameReadyAssetRules: GameReadyOptimizationSpec;
  systemExecutionPrompt: string;
}

export const IMAGE_TO_3D_WORLD_SKILL_PAYLOAD_V2: ImageTo3DZorldAgentSkill = {
  skillMetadata: {
    skillName: "ImageTo3DWorldOrchestrator",
    description: "Multi-agent orchestration pipeline converting a single 2D9 photo into a photorealistic, geographically exact 3D world. Features World Labs Marble-1.1 / Atlas Orchestrator Integration with Aleph .glb Structural Conditioning, isolated 3D assets, and game-engine export capabilities.",
    version: "2.0.0",
    primaryLLMOrchestrator: "Claude 3.5 Sonnet / Vision-LLM Orchestrator",
    worldLabsApiIntegration: {
      endpoint: "marble-1.1",
      structuralConditioning: {
        enabled: true,
        referenceFormat: "Aleph .glb",
        parameterName: "structural_conditioning_glb",
        geographicAlignment: true,
        photorealismBoost: true
      }
    },
    referenceImplementations: [
      "World Labs Marble-1.1 / Atlas API with Structural Conditioning",
      "Aleph 3D Structural Mesh Reference Extraction",
      "Standard Game-Ready 3D Pipeline (Blender + Substance Painter + UE5/Unity)"
    ]
  },

  requiredToolEcosystem: [
    {
      toolName: "ScenePerceptionModel",
      category: "VISION_LLM",
      recommendedModels: ["Claude 3.5 Sonnet", "GPT-4o Vision"],
      purpose: "Analyze 2D input photograph, detect objects, generate spatial bounding boxes, and produce an itemized asset manifest."
    },
    {
      toolName: "ImageInpaintingModel",
      category: "INPAINTING_EDIT",
      recommendedModels: ["Nano Banana Pro", "GPT Image 2.0"],
      purpose: "Isolate foreground objects from the input photo and cleanly inpaint background surfaces (walls, floors) without subject artifacts."
    },
    {
      toolName: "Mesh3DGenerator",
      category: "MESH_3D_GEN",
      recommendedModels: ["Tripo3D", "Trellis", "Luma Genie"],
      purpose: "Generate textured 3D meshes with automated UV unwrapping from single isolated object images."
    },
    {
      toolName: "AlephStructuralMeshExtractor",
      category: "STRUCTURAL_CONDITIONING",
      recommendedModels: ["Aleph Engine", "Depth-to-GLB Synthesizer"],
      purpose: "Generate an intermediate Aleph .glb structural mesh to serve as spatial, geometric, and depth reference for WorldLabs API."
    },
    {
      toolName: "WorldLabsSplatGenerator",
      category: "GAUSSIAN_SPLATTING",
      recommendedModels: ["World Labs Marble-1.1", "World Labs Atlas API", "3DGS"],
      purpose: "Synthesize a photorealistic, geographically exact 3D Gaussian Splat environment using structural conditioning parameters."
    },
    {
      toolName: "ColliderPhysicsGenerator",
      category: "PHYSICS_COLLIDER",
      recommendedModels: ["AutoMesh-Collider-Tool", "Unreal Engine Chaos Physics Generator"],
      purpose: "Generate 3D collision geometry (simplified convex hulls or mesh colliders) for environment bounds and spawned objects."
    },
    {
      toolName: "GameEngineExporter",
      category: "ENGINE_EXPORT",
      recommendedModels: ["Blender Python API (bpy)", "Unreal Engine Editor Utility Python / MCP"],
      purpose: "Assemble generated 3D meshes and Gaussian Splat environments into FBX/GLTF/USD formats ready for UE5, Unity, or VR."
    }
  ],

  pipelineStages: [
    {
      stageId: 1,
      stageName: "Scene Analysis & Object Manifesting",
      description: "Analyze the input 2D image, segment key interactive foreground objects (e.g., chairs, tables, lamps), and label coordinates.",
      inputArtifacts: ["input_photo.jpg"],
      outputArtifacts: ["scene_manifest.json", "object_bounding_boxes.json"],
      orchestratorAgentRole: "Vision-LLM Perception Agent",
      executingTools: ["ScenePerceptionModel"],
      promptTemplate: "Analyze the provided image in detail. Identify and itemize all distinct, movable physical objects separate from the static structural environment (walls, ground). Output a JSON manifest listing object names, estimated 3D bounding coordinates, and visual descriptions.",
      qualityGates: [
        "All prominent foreground objects are correctly named.",
        "Clear demarcation between movable props and fixed environment structures."
      ],
      errorHandling: "If scene perception is ambiguous, request user clarification or adjust object segmentation thresholds."
    },
    {
      stageId: 2,
      stageName: "Background Isolation & Inpainting",
      description: "Remove identified objects from the original photo and synthesize a clean background plate using AI inpainting.",
      inputArtifacts: ["input_photo.jpg", "object_bounding_boxes.json"],
      outputArtifacts: ["clean_environment_background.png", "isolated_object_crops/"],
      orchestratorAgentRole: "Image Editing Agent",
      executingTools: ["ImageInpaintingModel"],
      promptTemplate: "Inpaint and fill the regions where objects were removed. Reconstruct the background textures (walls, flooring, lighting) seamlessly without visual seams or ghosting.",
      qualityGates: [
        "Inpainted background exhibits no lingering object shadows or borders.",
        "Perspective lines and environmental lighting remain consistent."
      ],
      errorHandling: "Re-run inpainting with alternate seed or model fallback (e.g. switch from Nano Banana Pro to GPT Image 2.0)."
    },
    {
      stageId: 3,
      stageName: "3D Asset Generation & Material/UV Synthesis",
      description: "Convert isolated object image crops into individual 3D meshes complete with textures, materials, and UV maps.",
      inputArtifacts: ["isolated_object_crops/"],
      outputArtifacts: ["3d_assets/{object_id}.glb", "3d_assets/{object_id}_uv.png"],
      orchestratorAgentRole: "3D Generation Agent",
      executingTools: ["Mesh3DGenerator"],
      promptTemplate: "Convert single object image crop into a 3D mesh asset. Generate clean geometry, automated UV unwrapping layout, and PBR  texture maps.",
      qualityGates: [
        "Mesh geometry is watertight without unclosed holes.",
        "UV islands do not overlap and texture resolution preserves surface detail."
      ],
      errorHandling: "If mesh generation fails or distorts, retry with shape guidance prompts or multi-view synthesis."
    },
    {
      stageId: 4,
      stageName: "Aleph Structural Mesh Generation & World Labs API Orchestration",
      description: "Extract the Aleph .glb depth/structural reference mesh, then inject it as a Structural Conditioning parameter into World Labs Marble-1.1 or Atlas API to generate a geographically exact, photorealistic 3D Gaussian Splat environment.",
      inputArtifacts: ["clean_environment_background.png"],
      outputArtifacts: ["aleph_structure.glb", "splat_environment.ply", "world_labs_response.json"],
      orchestratorAgentRole: "World Labs API Orchestrator Agent",
      executingTools: ["AlephStructural MeshExtractor", "WorldLabsSplatGenerator"],
      promptTemplate: "Extract intermediate structural geometry into aleph_structure.glb. Construct World Labs API payload targeting Marble-1.1/Atlas, attaching aleph_structure.glb to the structural_conditioning_glb parameter to guarantee geographic accuracy.",
      apiPayloadTemplate: {
        endpoint: "https://api.worldlabs.ai/v1/generate/marble-1.1",
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer $WORLD_LABS_API_KEY" },
        body: {
          image_url: "clean_environment_background.png",
          structural_conditioning_glb: "aleph_structure.glb",
          conditioning_mode: "STRICT_GEOMETRIC_ALIGNMENT",
          output_format: "GAUSSIAN_SPLAT_PLY",
          render_quality: "ULTRA_PHOTOREALISTIC"
        }
      },
      qualityGates: [
        "Aleph .glb structural mesh matches clean background perspective and depth maps.",
        "World Labs API accepts structural_conditioning_glb parameter without validation errors.",
        "Generated splat geometry matches real-world scale and geographic proportions."
      ],
      errorHandling: "If World Labs API returns geometry misalignment error, recalculate Aleph .glb scale or fallback to standard depth conditioning."
    },
    {
      stageId: 5,
      stageName: "Spatial Assembly, Physics Colliders & Game Engine Handoff",
      description: "Combine World Labs 3D Gaussian Splat environment with generated 3D object meshes, generate collision hulls, and export for Unreal Engine, Unity, Blender, or VR",
      inputArtifacts: ["splat_environment.ply", "3d_assets/*.glb", "scene_manifest.json"],
      outputArtifacts: ["assembled_scene.json", "game_ready_package.fbx", "unreal_scene_setup.py"],
      orchestratorAgentRole: "Spatial Physics & Engine Export Agent",
      executingTools: ["ColliderPhysicsGenerator", "GameEngineExporter"],
      promptTemplate: "Attach physical collision geometry to splat ground/walls and anchor object GLBs to original spatial coordinates. Export FBX/GLTF package with python import scripts for UE5.",
      qualityGates: [
        "Camera can navigate 360 degrees without environment clipping.",
        "Collision geometry aligns accurately with structural splat boundaries.",
        "FBX/GLB files import cleanly into Unreal Engine / Unity with real-world unit scaling."
      ],
      errorHandling: "Run automated Blender/UE transform reset script if origins or scales misalign."
    }
  ],

  gameReadyAssetRules: {
    uvUnwrappingStrategy: "Efficient island layout with marked seams, avoiding overlaps and texture stretching, balancing visual detail and memory.",
    textureBakingMaps: ["Normal Map", "Roughness Map", "Base Color / Albedo", "Ambient Occlusion", "Metalness"],
    polygonBudget: {
      heroProp: 15000,
      standardProp: 5000,
      backgroundProp: 1500
    },
    supportedExportFormats: ["FBX", "GLTF/GLB", "USD", "PLY (Gaussian Splat)"],
    targetEngineEnvironments: ["Unreal Engine 5", "Unity", "Blender", "Marmoset Toolbag", "VR / WebXR"]
  },

  systemExecutionPrompt: "You are an autonomous AI 3D Asset Orchestration Agent with World Labs Structural Conditioning integration. Your job is to execute the Image-to-3D World pipeline. Given an input image, analyze objects, inpaint background, generate 3D meshes with UV maps, extract an Aleph .glb structural mesh, pass it as structural_conditioning_glb to World Labs Marble-1.1/Atlas API, generate photorealistic 3D Gaussian Splats, attach physics colliders, and export the scene for Unreal Engine or Unity."
};

export default IMAGE_TO_3D_WORLD_SKILL_PAYLOAD_V2;
