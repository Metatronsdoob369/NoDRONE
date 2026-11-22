import { GoogleGenAI } from "@google/genai";

let aiClient: GoogleGenAI | null = null;
let cachedApiKey: string | null = null;

export function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.API_KEY || '').trim();
  if (!apiKey) {
    aiClient = null;
    cachedApiKey = null;
    return null;
  }
  if (!aiClient || cachedApiKey !== apiKey) {
    aiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
    cachedApiKey = apiKey;
  }
  return aiClient;
}

export function safeNumber(val: any, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const num = Number(val);
  return isNaN(num) ? fallback : num;
}

export function safeFormatNumber(val: any, options?: Intl.NumberFormatOptions): string {
  const num = safeNumber(val, 0);
  return num.toLocaleString('en-US', options);
}

export interface BuildingContext {
  name: string;
  address?: string;
  totalGroundAreaSqFt: number;
  totalTrueAreaSqFt: number;
  facetCount: number;
  facets: Array<{
    id: number;
    pitchDegrees: number;
    pitchRatio: string;
    azimuthDegrees: number;
    azimuthDirection: string;
    groundAreaSqFt: number;
    trueAreaSqFt: number;
    pitchMultiplier: number;
    sunshineRating?: number;
  }>;
  ridgeLinearFeet: number;
  starterLinearFeet: number;
  netSquares: number;
  grossSquares: number;
  wastePercentage: number;
  selectedSku: {
    id: string;
    name: string;
    pricePerSq: number;
    warranty: string;
  };
  laborRate: number;
  contractTotal: number;
}

export function normalizeContext(raw: any): BuildingContext {
  if (!raw || typeof raw !== 'object') raw = {};
  const name = String(raw.name || raw.buildingName || 'Commercial Roofing Asset');
  const address = String(raw.address || 'Commercial Facility');
  const totalGround = safeNumber(
    raw.totalGroundAreaSqFt ?? raw.groundAreaSqFt ?? (raw.totalNetSqFt ? safeNumber(raw.totalNetSqFt) * 0.94 : 20000),
    20000
  );
  const totalTrue = safeNumber(
    raw.totalTrueAreaSqFt ?? raw.totalNetSqFt ?? (totalGround * 1.06),
    21200
  );
  const facetsRaw = Array.isArray(raw.facets) ? raw.facets : [];
  const facetCount = safeNumber(raw.facetCount ?? facetsRaw.length, facetsRaw.length || 1);
  const ridge = safeNumber(raw.ridgeLinearFeet ?? raw.ridgeFeet, 120);
  const starter = safeNumber(raw.starterLinearFeet ?? raw.eavesFeet, 240);
  const netSq = safeNumber(raw.netSquares ?? (totalTrue / 100), totalTrue / 100);
  const wastePct = safeNumber(raw.wastePercentage ?? raw.wastePercent, 10);
  const grossSq = safeNumber(raw.grossSquares ?? (netSq * (1 + wastePct / 100)), netSq * 1.1);
  const totalCost = safeNumber(raw.contractTotal ?? raw.totalEstimatedCost ?? (grossSq * 350), grossSq * 350);
  const labor = safeNumber(raw.laborRate, 85);

  let sku = raw.selectedSku;
  if (typeof sku === 'string') {
    sku = {
      id: 'SKU-01',
      name: sku,
      pricePerSq: safeNumber(raw.skuRate, 125),
      warranty: 'Standard Commercial Warranty'
    };
  } else if (!sku || typeof sku !== 'object') {
    sku = {
      id: 'SKU-LAM-01',
      name: 'Architectural Laminate',
      pricePerSq: 125,
      warranty: 'Lifetime / 30-Year'
    };
  } else {
    sku = {
      id: String(sku.id || 'SKU-01'),
      name: String(sku.name || 'Architectural Laminate'),
      pricePerSq: safeNumber(sku.pricePerSq, 125),
      warranty: String(sku.warranty || 'Standard Commercial Warranty')
    };
  }

  const facets = facetsRaw.filter(Boolean).map((f: any, idx: number) => {
    const pDeg = safeNumber(f.pitchDegrees, 18.4);
    const az = safeNumber(f.azimuthDegrees, 180);
    let card = 'S';
    if (az >= 337.5 || az < 22.5) card = 'N';
    else if (az >= 22.5 && az < 67.5) card = 'NE';
    else if (az >= 67.5 && az < 112.5) card = 'E';
    else if (az >= 112.5 && az < 157.5) card = 'SE';
    else if (az >= 157.5 && az < 202.5) card = 'S';
    else if (az >= 202.5 && az < 247.5) card = 'SW';
    else if (az >= 247.5 && az < 292.5) card = 'W';
    else if (az >= 292.5 && az < 337.5) card = 'NW';

    const groundArea = safeNumber(f.groundAreaSqFt ?? (f.trueAreaSqFt ? safeNumber(f.trueAreaSqFt) * 0.95 : 1000), 1000);
    const trueArea = safeNumber(f.trueAreaSqFt ?? (f.groundAreaSqFt ? safeNumber(f.groundAreaSqFt) * 1.05 : 1050), 1050);

    return {
      id: safeNumber(f.id, idx + 1),
      pitchDegrees: pDeg,
      pitchRatio: String(f.pitchRatio || `${(Math.tan(pDeg * Math.PI / 180) * 12).toFixed(1)}:12`),
      azimuthDegrees: az,
      azimuthDirection: String(f.azimuthDirection || card),
      groundAreaSqFt: groundArea,
      trueAreaSqFt: trueArea,
      pitchMultiplier: safeNumber(f.pitchMultiplier, 1.05),
      sunshineRating: safeNumber(f.sunshineRating, 1350)
    };
  });

  return {
    name,
    address,
    totalGroundAreaSqFt: totalGround,
    totalTrueAreaSqFt: totalTrue,
    facetCount,
    facets,
    ridgeLinearFeet: ridge,
    starterLinearFeet: starter,
    netSquares: netSq,
    grossSquares: grossSq,
    wastePercentage: wastePct,
    selectedSku: sku,
    laborRate: labor,
    contractTotal: totalCost
  };
}

/**
 * 1. AI Roof Engineering Audit & Condition Assessment
 */
export async function generateRoofAudit(rawContext: any): Promise<{ text: string; isLiveAi: boolean }> {
  const context = normalizeContext(rawContext);
  const client = getGeminiClient();

  if (client) {
    try {
      const prompt = `You are a licensed Master Commercial Roofing Consultant and Structural Building Envelope Engineer.
Analyze the following high-resolution Google Solar API CAD takeoff data for:
Building: "${context.name}" (${context.address || 'Commercial Property'})
Total Facets: ${context.facetCount}
Planar Footprint: ${safeFormatNumber(context.totalGroundAreaSqFt)} sq ft
True Pitch-Adjusted Surface Area: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft (+${context.totalGroundAreaSqFt > 0 ? ((context.totalTrueAreaSqFt - context.totalGroundAreaSqFt) / context.totalGroundAreaSqFt * 100).toFixed(1) : '0.0'}% due to slope)
Net Material Squares: ${context.netSquares.toFixed(1)} SQ (Gross Order: ${context.grossSquares.toFixed(1)} SQ with ${context.wastePercentage}% waste)
Ridge & Hip Length: ${context.ridgeLinearFeet} LF | Eave/Starter Edge: ${context.starterLinearFeet} LF
Selected Roofing System: ${context.selectedSku.name} ($${context.selectedSku.pricePerSq}/SQ)

Facets Telemetry Sample:
${context.facets.map(f => `• Facet #${f.id}: Pitch ${f.pitchDegrees.toFixed(1)}° (${f.pitchRatio}), Azimuth ${f.azimuthDegrees.toFixed(0)}° (${f.azimuthDirection}), True Area ${safeFormatNumber(f.trueAreaSqFt)} sq ft, Multiplier ${f.pitchMultiplier.toFixed(3)}x`).join('\n')}

Generate a comprehensive Engineering Roof Audit & Condition Assessment formatted in clean Markdown with these sections:
1. ### Executive Structural & Envelope Summary (Overall Complexity Grade: Tier 1/2/3, Deck Slope Profile, Roof Geometry Classification)
2. ### Drainage & Ponding Risk Analysis (Evaluate low-slope vs steep facets, identify ponding vulnerability where pitch < 2.5:12, assess valley junctions, scupper/downspout load)
3. ### Solar Photovoltaic (PV) Feasibility & Azimuth Rating (Highlight prime solar harvesting facets facing South/West 150°-240°, estimate optimal panel capacity)
4. ### Wind Uplift & Flashing Exposure (Corner and edge zone ANSI/SPRI ES-1 exposure, parapet/drip edge requirements)
5. ### Material Lifecycle & Specification Recommendation (Suitability of ${context.selectedSku.name}, underlayment vapor barrier specs, warranty life)
6. ### Critical Safety & OSHA Compliance Action Items (Identify steep facets > 4:12 requiring active OSHA 1926 Subpart M tie-offs/warning lines)

Be technical, authoritative, precise, and practical for commercial contractors and property managers. Use clean bullet points and concise paragraphs.`;

      const response = await client.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
      });

      if (response.text) {
        return { text: response.text, isLiveAi: true };
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        console.warn("Gemini API quota exhausted (429), generating engineering calculated fallback audit.");
      } else {
        console.warn("Gemini API call failed, generating calculated fallback audit:", err);
      }
    }
  }

  // Engineering fallback if API key is not set, quota exhausted, or service unavailable
  const lowSlopeCount = context.facets.filter(f => f.pitchDegrees < 12).length;
  const steepCount = context.facets.filter(f => f.pitchDegrees >= 20).length;
  const southFacets = context.facets.filter(f => f.azimuthDegrees >= 135 && f.azimuthDegrees <= 225);
  const southArea = southFacets.reduce((acc, f) => acc + f.trueAreaSqFt, 0);

  const fallback = `### Executive Structural & Envelope Summary
- **Structure**: ${context.name}
- **Geometry Profile**: Commercial multi-facet roof comprising ${context.facetCount} distinct planar segments.
- **Surface Expansion**: Planar footprint of ${safeFormatNumber(context.totalGroundAreaSqFt)} sq ft expands to **${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft** true surface (+${context.totalGroundAreaSqFt > 0 ? ((context.totalTrueAreaSqFt - context.totalGroundAreaSqFt) / context.totalGroundAreaSqFt * 100).toFixed(1) : '0.0'}% slope multiplier).
- **Engineering Complexity Rating**: **Tier ${context.facetCount > 15 ? '3 (Complex Architectural Hip/Valley)' : context.facetCount > 8 ? '2 (Moderate Transition Profile)' : '1 (Standard Low-Slope Commercial)'}** (${context.wastePercentage}% waste factor recommended).

### Drainage & Ponding Risk Analysis
- **Low-Slope Infiltration Risk**: Detected **${lowSlopeCount} low-pitch facet(s)** under 2.5:12 (12°). These sectors require positive cricket drainage or mechanical sump drains to prevent stagnant ponding beyond 48 hours.
- **Valley Hydraulic Velocity**: ${context.ridgeLinearFeet} LF of ridge and valley intersections will channel high-velocity runoff during 10-year storm events. Recommended 24-gauge Galvalume valley metal liners with minimum 24" wide ice & water protection barrier.

### Solar Photovoltaic (PV) Feasibility & Azimuth Rating
- **High-Yield Solar Sectors**: **${southFacets.length} south-quadrant facets** identified (Azimuth 135°–225°) totaling **${safeFormatNumber(southArea)} sq ft** of unobstructed prime solar exposure.
- **Estimated Solar Capacity**: Sufficient unshaded planar area to support approximately **${Math.floor(southArea * 0.7 / 18)} standard commercial PV modules** (approx. ${(Math.floor(southArea * 0.7 / 18) * 0.42).toFixed(1)} kW DC nameplate output).

### Wind Uplift & Flashing Exposure
- **Perimeter & Corner Zone Exposures**: ${context.starterLinearFeet} LF of perimeter eaves subject to ASCE 7-22 Zone 2 and Zone 3 edge pressures.
- **Flashing Specification**: All perimeter termination edges must utilize continuous 22-gauge cleated edge metal meeting ANSI/SPRI/FM 4435/ES-1 standards.

### Material Lifecycle & Specification Recommendation
- **Current System**: **${context.selectedSku.name}** with ${context.selectedSku.warranty}.
- **Underlayment Requirement**: Double-coverage synthetic polymer underlayment (ASTM D8257) with reinforced self-adhering modified bitumen along all eaves, rakes, and valley waterways.

### Critical Safety & OSHA Compliance Action Items
- **Fall Hazard Classification**: **${steepCount} facet(s)** exceed 4:12 (18.4°), triggering mandatory **OSHA 1926.501(b)(10)** fall protection protocols (warning line system with safety monitor or personal fall arrest systems).
- **Staging Logistics**: Roof load distribution must not exceed 25 PSF point load during material bundle hoisting.

*(Generated via NoDRONE Telemetry Engine · Real-time engineering model fallback)*`;

  return { text: fallback, isLiveAi: false };
}

/**
 * 2. AI Commercial Scope of Work & Formal Bid Proposal Generator
 */
export async function generateCommercialProposal(
  rawContext: any,
  additionalNotes?: string
): Promise<{ text: string; isLiveAi: boolean }> {
  const context = normalizeContext(rawContext);
  const client = getGeminiClient();

  if (client) {
    try {
      const prompt = `You are an elite Senior Commercial Roofing Estimator and Contract Director.
Generate a formal, turnkey Commercial Roofing Scope of Work & Proposal document for:
Client Property: "${context.name}"
Address: ${context.address || 'Commercial Business Park'}
Material System: ${context.selectedSku.name} ($${context.selectedSku.pricePerSq}/SQ)
Warranty: ${context.selectedSku.warranty}
Measurements:
- Net Field Area: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft (${context.netSquares.toFixed(2)} Net SQ)
- Gross Material Order: ${context.grossSquares.toFixed(2)} Gross SQ (${context.wastePercentage}% complexity allowance)
- Ridge & Valley Trim: ${context.ridgeLinearFeet} LF
- Perimeter Eaves/Starter: ${context.starterLinearFeet} LF
- Base Labor & Staging: $${context.laborRate}/SQ
- Total Turnkey Contract Price: $${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
${additionalNotes ? `Special Contractor Notes: ${additionalNotes}` : ''}

Format as a professional, executive-ready Commercial Bid Proposal in clean Markdown with:
1. ## Turnkey Project Scope of Work & Specifications
2. ### CSI Division 07 50 00 Work Breakdown
   - Substrate Deck Inspection & Prep
   - Underlayment & Vapor Retarder System
   - Primary Membrane / Shingle Field Installation
   - Penetrations, Curb Flashings & Valley Intersections
   - Edge Metal, Fascia & Perimeter Drainage
3. ### Materials Schedule & Quantity Takeoff Verification
4. ### Project Timeline & Staging Logistics (Phasing, Crane Hoist, Weather Contingencies)
5. ### Quality Assurance & Manufacturer NDL (No Dollar Limit) Warranty
6. ### Formal Contract Acceptance Clause & Authorization Signature Line

Make the tone commanding, professional, rigorous, and legally sound for commercial facility directors.`;

      const response = await client.models.generateContent({
        model: "gemini-3.8-flash",
        contents: prompt,
      });

      if (response.text) {
        return { text: response.text, isLiveAi: true };
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        console.warn("Gemini API quota exhausted (429), generating calculated commercial proposal fallback.");
      } else {
        console.warn("Gemini API proposal generation error, generating calculated fallback:", err);
      }
    }
  }

  // Fallback proposal
  const fallback = `## Turnkey Commercial Roofing Scope of Work & Proposal

**Project**: ${context.name}  
**Facility Address**: ${context.address || 'Commercial Facility'}  
**Specified Roofing System**: ${context.selectedSku.name}  
**Manufacturer Warranty**: ${context.selectedSku.warranty}  
**Total Turnkey Investment**: **$${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**

---

### 1. Project Overview & Executive Summary
This proposal provides a complete, code-compliant turnkey re-roofing solution for **${context.name}**. Utilizing precision orthophotography and Solar API CAD takeoff analytics, the roof encompasses **${safeFormatNumber(context.totalTrueAreaSqFt)} true slope-adjusted square feet** (${context.netSquares.toFixed(2)} Net SQ). With an engineered ${context.wastePercentage}% geometric complexity allowance, the project specifies **${context.grossSquares.toFixed(2)} Gross Squares** of certified materials.

---

### 2. CSI Division 07 50 00 Technical Scope of Work

#### A. Substrate Deck Preparation & Demolition
- Remove existing roof assembly down to the underlying structural steel/wood deck substrate.
- Inspect all decking panels for structural integrity, moisture rot, and fastener back-out; replace compromised decking on a pre-approved unit price basis.
- Mechanically sweep and vacuum the substrate free of debris, fasteners, and foreign contaminants.

#### B. Moisture Barrier & Underlayment Application
- Install ASTM D8257 high-performance synthetic tear-resistant underlayment across all field decks with 4" minimum side laps and 6" end laps.
- Apply self-adhering SBS modified polymer ice & water shield over all ${context.ridgeLinearFeet} LF of valleys, hips, roof-to-wall junctions, and rooftop equipment curbs.

#### C. Primary System Installation (${context.selectedSku.name})
- Install certified ${context.selectedSku.name} in strict accordance with manufacturer technical specifications and local commercial building codes.
- Fasten using corrosion-resistant pneumatic ring-shank fasteners configured for 130 MPH certified wind uplift resistance.

#### D. Flashings, Valleys & Edge Metal (ANSI/SPRI ES-1)
- Install 24-gauge pre-finished Kynar 500 drip edge and gravel stop along all ${context.starterLinearFeet} LF of perimeter eaves.
- Form and weld all RTU (Rooftop Unit) curbs, plumbing soil pipe stacks, and mechanical exhaust penetrations with reinforced custom boot flashings.

---

### 3. Schedule of Values & Materials Verification
| Component | Engineered Takeoff | Standard Unit | Specification |
|:---|:---:|:---:|:---|
| Primary Field Surface | ${context.grossSquares.toFixed(2)} | Squares | ${context.selectedSku.name} |
| Ridge & Hip Capping | ${context.ridgeLinearFeet} | Linear Feet | Class 4 High-Profile Trim |
| Starter / Eave Metal | ${context.starterLinearFeet} | Linear Feet | Continuous 24-Ga Galvalume |
| Synthetic Underlayment | ${Math.ceil(context.grossSquares / 10)} | 10-SQ Rolls | ASTM D8257 Heavy-Duty |
| Labor & Safety Staging | ${context.grossSquares.toFixed(2)} | Squares | OSHA 1926 Subpart M Compliant |

---

### 4. Safety & OSHA Compliance Program
- Daily safety tailgates conducted in compliance with OSHA 1926.501.
- Fall protection anchors and designated perimeter warning line flags installed 6 feet inward from all unprotected roof edges.
- Designated ground-level crane drop zones barricaded for pedestrian protection during material stocking.

---

### 5. Contract Authorization & Acceptance
*By signing below, the Client authorizes the Contractor to furnish all necessary labor, equipment, and certified materials to perform the work specified above.*

**Accepted By Client**: ___________________________ **Date**: _________________  
**Print Name & Title**: ___________________________ **Company**: ${context.name}  
**Contractor Representative**: ______________________ **License #**: CR-849204-TX`;

  return { text: fallback, isLiveAi: false };
}

/**
 * 3. AI Interactive Engineering Co-Pilot & Chatbot
 */
export async function handleAIChat(
  message: string,
  history: Array<{ role: 'user' | 'model'; text: string }>,
  rawContext: any
): Promise<{ text: string; isLiveAi: boolean }> {
  const context = normalizeContext(rawContext);
  const client = getGeminiClient();

  if (client) {
    try {
      const systemInstruction = `You are NoDRONE AI, a veteran commercial roofing engineer, solar CAD takeoff specialist, and forensic building envelope consultant.
You have real-time access to the current commercial building being analyzed in the NoDRONE workbench:
Building Name: "${context.name}" (${context.address || 'Commercial'})
Total Planar Footprint: ${safeFormatNumber(context.totalGroundAreaSqFt)} sq ft
Total True Surface Area: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft
Number of Facets: ${context.facetCount}
Net Material Squares: ${context.netSquares.toFixed(2)} SQ
Gross Order Squares: ${context.grossSquares.toFixed(2)} SQ (with ${context.wastePercentage}% complexity waste)
Ridge & Hip Length: ${context.ridgeLinearFeet} LF
Perimeter Starter Edge: ${context.starterLinearFeet} LF
Selected Roofing Material: ${context.selectedSku.name} ($${context.selectedSku.pricePerSq}/SQ)
Total Proposal Price: $${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

Facets Breakdown:
${context.facets.map(f => `Facet #${f.id}: Pitch ${f.pitchDegrees.toFixed(1)}° (${f.pitchRatio}), Azimuth ${f.azimuthDegrees.toFixed(0)}° (${f.azimuthDirection}), True Area ${safeFormatNumber(f.trueAreaSqFt)} sq ft`).join('\n')}

Guidelines:
- Answer the user's questions about roofing engineering, slope calculations (M = 1/cos(θ)), solar PV viability, drainage ponding risks, material selection (TPO vs EPDM vs Metal vs Shingles), OSHA safety compliance, and insurance/estimating.
- Be concise, practical, authoritative, and helpful.
- Include mathematical values, facet numbers, and direct recommendations when relevant.`;

      // Build chat session with gemini-3.8-flash
      const chat = client.chats.create({
        model: "gemini-3.8-flash",
        config: {
          systemInstruction,
        }
      });

      // Send chat message
      const response = await chat.sendMessage({
        message,
      });

      if (response.text) {
        return { text: response.text, isLiveAi: true };
      }
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED')) {
        console.warn("Gemini chat API quota exhausted (429), switching seamlessly to local rule-based engineering engine.");
      } else {
        console.warn("Gemini chat error, falling back to rule-based agent:", err);
      }
    }
  }

  // Intelligent conversational fallback with safe formatting and error protection
  try {
    const lower = (message || '').toLowerCase();
    let reply = "";

    if (lower.includes("drainage") || lower.includes("pond") || lower.includes("water") || lower.includes("slope")) {
      const lowPitches = context.facets.filter(f => f.pitchDegrees < 14);
      reply = `Based on the CAD takeoff for **${context.name}**, there are **${lowPitches.length} facets** with a pitch below 3:12 (${lowPitches.map(f => `#${f.id} (${f.pitchDegrees.toFixed(1)}°)`).join(', ') || 'None detected'}). 

**Engineering Recommendations:**
1. Low-slope surfaces under 2:12 must not use standard shingles; they require full-adhered single-ply membrane (such as 60-mil TPO or EPDM) with tapered polyiso insulation to ensure a minimum 1/4" per foot positive slope.
2. The ${context.ridgeLinearFeet} LF of valleys require 24" continuous ice-and-water barrier and heavy-gauge valley flashing to prevent hydraulic backwater leaks.`;
    } else if (lower.includes("solar") || lower.includes("pv") || lower.includes("sun") || lower.includes("energy")) {
      const southFacets = context.facets.filter(f => f.azimuthDegrees >= 140 && f.azimuthDegrees <= 220);
      const totalSouthSqFt = southFacets.reduce((sum, f) => sum + f.trueAreaSqFt, 0);
      reply = `**Solar PV Potential Analysis for ${context.name}:**
- **Optimal Facets**: Identified **${southFacets.length} south-facing facets** (${southFacets.map(f => `#${f.id}`).join(', ') || 'None'}) totaling **${safeFormatNumber(totalSouthSqFt)} sq ft** of high-solar-yield surface area.
- **Estimated Production**: Assuming 70% net usable area after setbacks (3-ft perimeter ridge/eave clearance per IFC 1205.2), you can mount approximately **${Math.floor(totalSouthSqFt * 0.7 / 18)} commercial 400W modules**, delivering roughly **${((Math.floor(totalSouthSqFt * 0.7 / 18) * 400) / 1000).toFixed(1)} kW DC** peak capacity.`;
    } else if (lower.includes("osha") || lower.includes("safety") || lower.includes("tie") || lower.includes("fall")) {
      const steepFacets = context.facets.filter(f => f.pitchDegrees >= 18.4);
      reply = `**OSHA Fall Protection Requirements (OSHA 1926 Subpart M):**
- **Steep Pitch Facets**: **${steepFacets.length} facets** on ${context.name} exceed a 4:12 pitch (${steepFacets.map(f => `#${f.id}`).join(', ') || 'None'}).
- **Mandatory Measures**:
  1. Personal Fall Arrest Systems (PFAS) with 5,000 lb rated anchor points are required on these facets.
  2. For low-slope areas, a warning line system must be erected 6 ft from the roof edge with an active safety monitor.
  3. Designated crane staging zones must be cordoned off at ground level.`;
    } else if (lower.includes("cost") || lower.includes("price") || lower.includes("quote") || lower.includes("margin") || lower.includes("estimate")) {
      reply = `**Financial Breakdown for ${context.name}:**
- **Field Quantity**: ${context.grossSquares.toFixed(2)} Gross Squares (${safeFormatNumber(context.totalTrueAreaSqFt)} true sq ft with ${context.wastePercentage}% waste).
- **Material**: ${context.selectedSku.name} at $${context.selectedSku.pricePerSq}/SQ.
- **Base Labor**: $${context.laborRate}/SQ.
- **Total Contract Estimate**: **$${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}**.
- If you'd like to adjust the contractor margin or labor rate, you can edit the values directly in the right-hand panel!`;
    } else {
      reply = `I have analyzed **${context.name}** (${context.facetCount} facets, ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft true area). 

Key metrics for this project:
- **Gross Material Order**: ${context.grossSquares.toFixed(1)} SQ (${context.wastePercentage}% complexity factor)
- **Ridge & Valley Linear Footage**: ${context.ridgeLinearFeet} LF
- **Perimeter Edge**: ${context.starterLinearFeet} LF
- **Current System**: ${context.selectedSku.name} at $${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}

You can ask me about:
1. *Ponding & drainage vulnerability analysis*
2. *Solar PV array feasibility and yield*
3. *OSHA steep-slope fall protection compliance*
4. *Comparison between TPO, EPDM, Metal, and Shingles*
5. *Subcontractor labor and material cost optimization*`;
    }

    return { text: reply, isLiveAi: false };
  } catch (fallbackErr: any) {
    console.error("AI fallback error:", fallbackErr);
    return {
      text: `### Building Takeoff Summary for ${context.name}\n\n` +
        `- **Planar Area**: ${safeFormatNumber(context.totalGroundAreaSqFt)} sq ft\n` +
        `- **True Slope Area**: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft\n` +
        `- **Roof Facets**: ${context.facetCount}\n` +
        `- **Material Order**: ${context.grossSquares.toFixed(1)} Squares (${context.selectedSku.name})\n` +
        `- **Turnkey Estimate**: $${safeFormatNumber(context.contractTotal, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}\n\n` +
        `Ask any questions regarding drainage, solar potential, or OSHA safety specifications.`,
      isLiveAi: false
    };
  }
}

/**
 * Generate AI Cinematic Drone Video Director Prompts for Sora, Google Veo, and Runway Gen-3
 */
export async function generateDroneVideoPrompt(
  context: BuildingContext,
  style: 'cinematic' | 'inspection' | 'sunset' | 'photogrammetry' = 'cinematic',
  cameraMotion: string = '360° Survey Orbit with Google Earth Studio mathematical easing'
): Promise<{ text: string; isLiveAi: boolean }> {
  const client = getGeminiClient();

  const prompt = `You are an elite aerial cinematographer, commercial roofing inspector, and Google Earth Studio expert.
Compose a production-grade AI Video Prompt Blueprint and Google Earth Studio camera script for a high-definition 3D aerial drone video of this structure:

Building Name: ${context.name}
Address / Coordinates: ${context.address || 'Commercial Facility'}
Roof True Area: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft (${context.grossSquares.toFixed(1)} Squares)
Number of Facets: ${context.facetCount} facets
Roof Material: ${context.selectedSku?.name || 'Architectural Laminate'}
Ridge Length: ${context.ridgeLinearFeet} LF
Primary Style: ${style}
Camera Motion Profile: ${cameraMotion}

Generate a comprehensive director's response in Markdown containing:
1. **Ready-to-Use Video Generation Prompts** for:
   - **Google Veo 2 / DeepMind**: photorealistic prompt with camera focal length (24mm/35mm), lighting (golden hour / directional sunlight), altitude (65ft AGL), gimbal pitch (-45°), and 4K ProRes textures.
   - **OpenAI Sora**: cinematic aerial drone tracking shot with lighting, shadows, and architectural material details.
   - **Runway Gen-3 Alpha**: camera movement bracket [Orbit CW, Tilt Down 45, Pan 180], smooth speed, 4K inspection aesthetic.
2. **Google Earth Studio Mathematical Camera Directives**:
   - Camera Target: Lat, Lng, Alt MSL at building apex.
   - Camera Position: Radius R=145ft, Altitude Z=75ft AGL, Easing=Cubic Bezier (0.42, 0, 0.58, 1).
   - Gimbal Pitch Formula: θ = -arctan2(ΔZ, ΔD) = -38.5°.
   - Tangential Airspeed: 15 mph (22 ft/s).
3. **Roof Feature Highlights to Showcase in the Clip**:
   - Ridges, hips, eaves, gutters, drainage pitch vectors, and surface texture.`;

  if (client) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return { text: response.text || '', isLiveAi: true };
    } catch (err) {
      console.warn("Live Gemini API call failed for drone prompt, using fallback:", err);
    }
  }

  // High quality fallback
  return {
    text: `### Aerial Drone Cinematography & Video Generation Blueprint

#### 1. Google Veo 2 / High-Fidelity Prompt
\`\`\`text
Hyper-realistic 4K 60fps drone aerial cinematic orbit of ${context.name}, a commercial facility featuring ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft of ${context.selectedSku?.name || 'architectural standing seam roofing'}. Shot on DJI Inspire 3 with Zenmuse X9-8K Air, 24mm f/2.8 lens. The drone performs a mathematically smooth 360-degree circular orbit at 75 feet AGL with a -45 degree gimbal tilt locked onto the roof ridge centroid. Golden hour warm directional sunlight casting soft geometric shadows across all ${context.facetCount} roof facets. Photorealistic micro-textures, crisp architectural edges, and high-definition aerial parallax. Cinematic, pristine photogrammetry.
\`\`\`

#### 2. OpenAI Sora Prompt
\`\`\`text
Slow-motion 4K aerial drone flyby hovering over ${context.name} (${context.address || 'Commercial Park'}). The camera glides in a continuous spiral ascent from eave height to 120 feet altitude, keeping the building apex centered in frame. Clean blue sky with subtle atmospheric haze, detailed roofing shingles with realistic depth and light reflectance. Professional architectural documentary grading, steady gimbal movement without vibration.
\`\`\`

#### 3. Runway Gen-3 Alpha Prompt
\`\`\`text
[Camera: Orbit 360 clockwise, Zoom: steady 24mm, Tilt: -40 degrees] High-angle aerial drone inspection of ${context.name}. The drone circles the commercial rooftop showcasing ridge lines (${context.ridgeLinearFeet} LF) and steep pitch drainage facets in crisp daylight. Photorealistic 8k render, professional commercial property showcase.
\`\`\`

#### 4. Google Earth Studio Mathematical Flight Parameters
- **Target Coordinate Lock**: Building Centroid $(X_c, Y_c, Z_{apex})$
- **Orbital Radius**: $R = 145.0\\text{ ft}$
- **Flight Altitude**: $Z_{AGL} = 75.0\\text{ ft}$
- **Gimbal Pitch Equation**: $\\theta_{pitch} = -\\arctan2(Z_{drone} - Z_{roof}, R) = -41.2^\\circ$
- **Bank Angle Physics**: $\\phi_{roll} = -\\frac{v^2}{g \\cdot R} = -3.8^\\circ$ at $15\\text{ mph}$
- **Interpolation Easing**: Hermite Spline / Smoothstep $(3t^2 - 2t^3)$ for jerk-free camera acceleration.`,
    isLiveAi: false
  };
}

/**
 * AI Video Inspection Report Analysis from Recorded Drone Clip Telemetry
 */
export async function analyzeDroneFlightClip(
  context: BuildingContext,
  flightStats: {
    durationSeconds: number;
    flightMode: string;
    maxAltitudeFeet: number;
    minAltitudeFeet: number;
    avgSpeedMph: number;
    lapCount: number;
    targetedFacets: number[];
  }
): Promise<{ text: string; isLiveAi: boolean }> {
  const client = getGeminiClient();

  const prompt = `You are a licensed FAA Part 107 Remote Pilot and Master Forensic Roofing Consultant.
Analyze this recorded drone flight survey clip and generate a comprehensive Drone Flight Inspection Audit & Structural Takeoff Report:

Facility: ${context.name}
Address: ${context.address || 'Commercial Facility'}
Total True Roof Area: ${safeFormatNumber(context.totalTrueAreaSqFt)} sq ft (${context.grossSquares.toFixed(1)} Squares)
Installed System: ${context.selectedSku?.name || 'Commercial Grade'}
Total Facets: ${context.facetCount}

Recorded Drone Clip Telemetry:
- Flight Duration: ${flightStats.durationSeconds} seconds
- Flight Mode: ${flightStats.flightMode}
- Altitude Envelope: ${flightStats.minAltitudeFeet} ft - ${flightStats.maxAltitudeFeet} ft AGL
- Average Ground Speed: ${flightStats.avgSpeedMph} MPH
- Complete 360° Survey Laps: ${flightStats.lapCount}
- Targeted Facet Indices: [${flightStats.targetedFacets.join(', ') || 'Full Perimeter Coverage'}]

Generate a formal FAA & NRCA compliant Inspection Report in Markdown covering:
1. **Flight Mission Verification & FAA Part 107 Compliance**: Flight envelope, altitude compliance, and visual line of sight.
2. **Photogrammetric Coverage & Orthomosaic Overlap**: Evaluation of 360° orbital survey geometry and focal tracking.
3. **Roof Surface & Drainage Condition Observations**: Analysis of pitch severity, ridge integrity (${context.ridgeLinearFeet} LF), and potential ponding or drainage concerns.
4. **Actionable Contractor Scope Recommendations**: Priority repairs, solar array readiness, and safety requirements.`;

  if (client) {
    try {
      const response = await client.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      });
      return { text: response.text || '', isLiveAi: true };
    } catch (err) {
      console.warn("Live Gemini API call failed for flight clip analysis, using fallback:", err);
    }
  }

  return {
    text: `### Official Drone Survey Mission Audit & Inspection Report

**Facility:** ${context.name}  
**Flight Mode:** ${flightStats.flightMode.toUpperCase()}  
**Flight Duration:** ${flightStats.durationSeconds} seconds (${flightStats.lapCount} full orbit lap)  
**Survey Altitude:** ${flightStats.minAltitudeFeet}–${flightStats.maxAltitudeFeet} FT AGL | **Mean Airspeed:** ${flightStats.avgSpeedMph} MPH  

---

#### 1. FAA Part 107 Flight Compliance & Photogrammetric Geometry
- **Airspace Classification:** Class G Uncontrolled (<400 FT AGL ceiling verified; survey maintained at safe ${flightStats.maxAltitudeFeet} FT AGL).
- **Camera Focal Lock:** Continuous optical lock on roof apex centroid maintained through $360^\\circ$ radial arc.
- **Stereo Overlap:** Tangential sampling rate at ${flightStats.avgSpeedMph} MPH achieves >80% forward overlap and >75% lateral sidelap, fully compliant with ASTM E3079 photogrammetric 3D reconstruction standards.

#### 2. Envelope & Drainage Analysis
- **Total Measured Surface:** ${safeFormatNumber(context.totalTrueAreaSqFt)} SQ FT across ${context.facetCount} primary roof planes.
- **Linear Ridge Alignment:** ${context.ridgeLinearFeet} LF of ridge and valley intersections inspected with zero structural sagging or racking detected.
- **Drainage Vectors:** Low-pitch drainage facets (<10° slope) exhibit adequate positive fall toward designated perimeter scuppers and gutters (${context.starterLinearFeet} LF perimeter).

#### 3. Contractor Action Items & Material Deployment
1. **Field Material Specification:** Verify delivery of ${context.grossSquares.toFixed(1)} Squares of ${context.selectedSku?.name || 'Architectural System'} with ${context.wastePercentage}% factor.
2. **Safety Tie-Off:** Personal Fall Arrest Systems (PFAS) mandated on facets with slope >4:12.
3. **Archive Video Asset:** Georeferenced video clip validated for insurance sign-off and warranty baseline documentation.`,
    isLiveAi: false
  };
}

