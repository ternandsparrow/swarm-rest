const express = require('express')
const axios = require('axios')
const pino = require('pino')
const expressPino = require('express-pino-logger')
const jsonld = require('jsonld')
const Sentry = require('@sentry/node')

const port = process.env.PORT || 3000
let cachedValue = null
let cacheLastUpdated = 0
const cacheExpirySeconds =
  parseInt(process.env.CACHE_EXPIRY_SECONDS) || 4 * 60 * 60
const jsonLdSourceUrl = (() => {
  const defaultValue =
    'https://linkeddata.tern.org.au/viewer/ausplots/download?format=json-ld'
  return process.env.JSONLD_URL || defaultValue
})()
const categoricalVariablesContainerId = (() => {
  const defaultValue =
    'http://linked.data.gov.au/def/ausplots-cv/55e652ef-b1f9-448a-97d4-a28cfc74e7c4'
  return process.env.CAT_VAR_ID || defaultValue
})()
const p = 'http://linked.data.gov.au/def/ausplots-cv'
const bioregionNameCatVarId = `${p}/a9754a72-c2f7-4a9d-9686-9df78fb65e62`
const observerCatVarId = `${p}/f06cad16-dce2-412a-9e47-1834b483b8db`
const stateCatVarId = `${p}/c27df9ec-ef2a-482c-b79f-22b03efcacd4`
const datumCatVarId = `${p}/3b2c4499-9257-498d-a18f-6405e5ca8787`
const sentryDsn = process.env.SENTRY_DSN

const app = express()
const logger = pino({ level: process.env.LOG_LEVEL || 'info' })
if (sentryDsn) {
  logger.debug('Initialising Sentry')
  Sentry.init({ dsn: sentryDsn })
  // must be first middleware
  app.use(Sentry.Handlers.requestHandler())
} else {
  logger.debug('No Sentry DSN, refusing to initialise Sentry')
}
const expressLogger = expressPino({ logger })
app.use(expressLogger)

app.get('/', async (req, res) => {
  try {
    const result = await getResult()
    res.send(result)
  } catch (err) {
    Sentry.captureException(err)
    logger.error(err)
    res.status(500).send({ status: 500, msg: 'Internal Server Error' })
  }
})

async function getResult() {
  const isCacheExpired =
    Date.now() > cacheLastUpdated + cacheExpirySeconds * 1000
  if (cachedValue && !isCacheExpired) {
    logger.info('Using cached data')
    return cachedValue
  }
  logger.info('Cache is empty or expired, rebuilding')
  cacheLastUpdated = Date.now()
  const allJsonLdData = await getAllJsonLdData()
  const result = await parseData(allJsonLdData)
  cachedValue = result
  return cachedValue
}

async function getAllJsonLdData() {
  logger.debug(`Using JSON-LD source URL: ${jsonLdSourceUrl}`)
  const resp = await axios.get(jsonLdSourceUrl)
  return resp.data
}

async function parseData(data) {
  const context = {
    // unsure if context is available from somewhere, so I hand-crafted it
    prefLabel: 'http://www.w3.org/2004/02/skos/core#prefLabel',
    notation: 'http://www.w3.org/2004/02/skos/core#notation',
    label: 'http://www.w3.org/2000/01/rdf-schema#label',
    description: 'http://purl.org/dc/terms/description',
    definition: 'http://www.w3.org/2004/02/skos/core#definition',
    member: {
      '@id': 'http://www.w3.org/2004/02/skos/core#member',
      '@type': '@id',
    },
  }
  const compacted = await jsonld.compact(data, context)
  const graph = compacted['@graph']
  const catVarContainer = graph.find(
    e => e['@id'] === categoricalVariablesContainerId,
  )
  if (!catVarContainer) {
    throw new Error(
      `Could not find categorical variable container with ID=${categoricalVariablesContainerId}`,
    )
  }
  const varsToProcess = [
    ...catVarContainer.member,
    bioregionNameCatVarId,
    observerCatVarId,
    stateCatVarId,
  ]
  const ignoreList = [
    `${p}/9dc8290e-ce1f-48b3-a6d3-78acf1f56b7b`, // Miscellaneous
    `${p}/1e3327d0-e572-4c6b-8836-b4e226adc089`, // Vegetation strata values
  ]
  const variables = varsToProcess.reduce((accum, currVarId) => {
    const currVar = getEntityFromGraph(graph, currVarId)
    if (ignoreList.includes(currVarId)) {
      logger.debug(`Ignoring variable with ID=${currVarId}`)
      return accum
    }
    const values = processValues(currVar, graph)
    for (const currValue of values) {
      // we have some variables that share the same vocab, so we need to make
      // sure we adjust the values for this particular usage.
      const mappings = getVariableCodeMappings(currVar)
      for (const currMapping of mappings) {
        const variableCode = currMapping.code || currMapping
        const variableLabel =
          currMapping.label ||
          currVar.label ||
          currVar.prefLabel ||
          variableCode
        accum.push({
          variableCode,
          variableLabel,
          variableDefinition: currVar.definition,
          variableValueCode: currValue.code,
          variableValueLabel: currValue.label,
          variableValueDefinition: currValue.definition,
        })
      }
    }
    return accum
  }, [])
  const nonVocabVarsToProcess = [
    [`${p}/5ff6bc93-0d26-420f-80de-a898d51962aa`, 'basal_area'],
    [`${p}/cde9be44-f208-4411-9f16-9dab96d4c425`, 'climatic_condition'],
    [`${p}/aa11e5f7-aec2-4e92-95b8-6332911f0c4e`, 'colour_when_dry'],
    [`${p}/7d6a1fdb-111a-4dbe-8534-a5e48d79750c`, 'colour_when_moist'],
    [`${p}/2ec446bb-a098-4016-9fca-80c667597bbe`, 'dead'],
    [`${p}/85a6a2b1-51e4-4fe4-9792-da54423ba3cf`, 'ec'],
    [`${p}/8b217978-1aec-4e4a-ac9d-b08a47ebf0a4`, 'height'],
    [`${p}/7f3ca1bc-ba41-49b6-adb9-05e640f89d79`, 'horizon'],
    [`${p}/bc8156c2-c2a7-4b2b-8ece-3f1959734d6e`, 'in_canopy_sky'],
    [`${p}/11eb41e9-4f8f-4998-8443-e2748d8081a0`, 'lower_depth'],
    [`${p}/7903d149-6fcd-4038-928c-4987b00e451e`, 'mass_flowering_event'],
    [`${p}/e8bde3f7-0c4f-442e-8e88-08273f57fec8`, 'ground_1_dominant'],
    [`${p}/e9aa8f39-4fb9-49fc-b48b-861c22d57971`, 'ground_2_dominant'],
    [`${p}/3e1d9d34-023a-47ae-9b2c-e07eeaaea2ce`, 'ground_3_dominant'],
    [`${p}/9f770911-7b5c-45c8-b35f-f6dbc7840659`, 'mid_1_dominant'],
    [`${p}/53f39410-6e5c-4555-81b4-ce0d48b22166`, 'mid_2_dominant'],
    [`${p}/d99a8ef8-bcac-4496-b3e6-5d0391e0c7c9`, 'mid_3_dominant'],
    [`${p}/69ed5cf9-e617-4f4a-bb13-899351317e52`, 'upper_1_dominant'],
    [`${p}/ef5bc0c0-8e17-4d33-a019-6c86c6ce7df0`, 'upper_2_dominant'],
    [`${p}/91d40b5f-aec1-4812-8277-a35af77c3caa`, 'upper_3_dominant'],
    [`${p}/686c8e7b-78ab-4094-8a38-733eefe21e0a`, 'ph'],
    [`${p}/b6049501-b90f-4ab0-b64b-dff4f588e3e4`, 'site_aspect'],
    [`${p}/8ad3966c-9f23-4df9-9c37-5b8cee679356`, 'site_slope'],
    [`${p}/ff69c254-e549-45e8-a320-e28ead5092c8`, 'vegetation_condition'],
  ]
  nonVocabVarsToProcess.forEach(([currVarId, variableCode]) => {
    const currVar = getEntityFromGraph(graph, currVarId)
    variables.push({
      variableCode: variableCode,
      variableLabel: currVar.label || currVar.prefLabel || variableCode,
      variableDefinition: currVar.definition,
      variableValueCode: null,
      variableValueLabel: null,
      variableValueDefinition: null,
    })
  })
  // variables that we'll never find a definition for elsewhere as they're
  // specific to our R package.
  const ausplotsRSpecificVars = [
    [
      'authorship',
      'standardised author of taxonomic name from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'family',
      'plant family from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'genus',
      'plant genus from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'genus_species',
      'species level scientific name matched to the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'hits_unique',
      'unique point intercept hit identifier concatenation of transect and point_number',
    ],
    [
      'infraspecific_epithet',
      'epithet or name identifying infraspecific taxon matched to the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'infraspecific_rank',
      'rank of infraspecific taxon matched to the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'published_in',
      'taxonomic publication details from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'rank',
      'lowest applicable taxonomic rank from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'site_unique',
      'unique site survey identifier concatenation of site_location_name and site_location_visit_ID',
    ],
    [
      'specific_epithet',
      'epithet or name identifying species matched to the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'standardised_name',
      'scientific name at lowest available taxonomic level matched to the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'taxa_group',
      'major plant taxonomic group from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
    [
      'taxa_status',
      'flag for accepted plant name from the Australian Plant Census (APC) and Australian Plant Names Index (APNI)',
    ],
  ]
  ausplotsRSpecificVars.forEach(([currVarId, currVarDef]) => {
    variables.push({
      variableCode: currVarId,
      variableLabel: currVarId,
      variableDefinition: currVarDef,
      variableValueCode: null,
      variableValueLabel: null,
      variableValueDefinition: null,
    })
  })
  variables.sort((a, b) => {
    if (a.variableCode < b.variableCode) {
      return -1
    }
    if (a.variableCode > b.variableCode) {
      return 1
    }
    if (a.variableValueCode < b.variableValueCode) {
      return -1
    }
    if (a.variableValueCode > b.variableValueCode) {
      return 1
    }
    return 0
  })
  return variables
}

function getVariableCodeMappings(val) {
  const mapping = {
    [`${p}/e502f1db-b8fe-4e32-9a1a-f761b9e98029`]: ['point_id'],
    [bioregionNameCatVarId]: ['bioregion_name'],
    [`${p}/5acbf972-3cf2-4516-9a07-1fa1b8a2acbd`]: ['coarse_frag_abund'],
    [`${p}/b446ff51-dc76-472e-bb2f-19706a089b32`]: ['coarse_frag_shape'],
    [`${p}/9a280139-f00e-45ab-b08e-93e3164b4bd2`]: ['coarse_frag_size'],
    [datumCatVarId]: [{ code: 'pit_marker_datum', label: 'Pit marker datum' }],
    [`${p}/f0f17aeb-8d72-4b17-9a13-f625cdc30c08`]: ['disturbance'],
    [`${p}/bca813f6-9182-43a5-8975-8d804cc61b31`]: ['drainage_type'],
    [`${p}/aa40dc68-706e-4273-a547-3235def21d1c`]: ['effervescence'],
    [`${p}/23609456-c133-452f-a06c-feffbdedd64e`]: ['erosion_abundance'],
    [`${p}/0b12c523-e44d-43ab-8b42-976e7d1fac1b`]: ['erosion_state'],
    [`${p}/34c89174-82d6-421d-8d08-756292adc465`]: ['erosion_type'],
    [`${p}/eae155c7-669c-463a-8d01-01b090472732`]: ['growth_form'],
    [`${p}/1a250c12-c95e-401e-9f16-8bce83bd691d`]: ['landform_element'],
    [`${p}/4f9e9fa9-5327-45fa-9ab2-be81e7a2a89c`]: ['landform_pattern'],
    [`${p}/cb0c2aab-6556-4344-9d5d-5bd0ecab2267`]: [
      { code: 'outcrop_lithology', label: 'Outcrop lithology' },
      { code: 'other_outcrop_lithology', label: 'Other outcrop lithology' },
    ],
    [`${p}/5b18e191-31f1-459b-90a0-31ee3f614846`]: [
      { code: 'pit_marker_mga_zones', label: 'Pit marker MGA zone' },
    ],
    [`${p}/222c85bc-a6f7-4e78-87ef-9684f513bcc6`]: ['microrelief'],
    [`${p}/16b85cbf-7956-4131-bf21-2d9e7a08cb96`]: ['mottles_abundance'],
    [`${p}/c9c9d4df-6342-45b8-ab99-b07496cadf1b`]: ['mottles_colour'],
    [`${p}/b512f19f-f659-4e32-b9a0-18aa72c25333`]: ['mottles_size'],
    [observerCatVarId]: [
      { code: 'observer_veg', label: 'Observer veg' },
      { code: 'observer_soil', label: 'Observer soil' },
      { code: 'described_by', label: 'Described by' },
      { code: 'collected_by', label: 'Collected by' },
    ],
    [`${p}/009e5822-4344-4b5a-832b-46a3adcf042f`]: ['pedality_fabric'],
    [`${p}/c8029ec5-940f-48cc-b3d1-50cadf3dc2fd`]: ['pedality_grade'],
    [`${p}/337b09de-0b39-43d8-b2f0-417e1085bf2e`]: ['pedality_type'],
    [`${p}/32ce77a0-dc9e-459b-9c91-4da904dbe7d6`]: ['segregations_abundance'],
    [`${p}/2ecd0e04-d5cd-4748-849a-ff6810567835`]: ['segregations_form'],
    [`${p}/a58f8f2e-6067-48af-b0f7-c8c19c811ba2`]: ['segregations_nature'],
    [`${p}/b2e65552-b85a-4c01-a953-7934bd65b84f`]: ['segregations_size'],
    [`${p}/0968f477-fe5d-4c90-b4b3-71a41bcba3e2`]: ['texture_grade'],
    [`${p}/55775cfc-eb1c-4151-904a-1654a2649799`]: ['texture_modifier'],
    [`${p}/a7258bee-8f9f-4f0f-ae77-a5def5c22936`]: ['texture_qualifier'],
    [stateCatVarId]: ['state'],
    [`${p}/d6f16e28-0913-4b06-9919-c13d9a9f0832`]: [
      { code: 'smallest_size_1', label: 'Smallest Size 1' },
      { code: 'smallest_size_2', label: 'Smallest Size 2' },
    ],
    [`${p}/b15f3b2b-99dd-4ec4-b1ad-15ee7ed1658e`]: ['substrate'],
    [`${p}/9be3370e-6bce-4418-a4f5-ba3800951344`]: ['surface_soil_condition'],
    [`${p}/fc51058d-ab4b-4875-9655-7356d1b6a009`]: ['surface_strew_size'],
  }
  const id = val['@id']
  const found = mapping[id]
  if (found) {
    return found
  }
  sentryWarn(
    `Programmer problem: Could not find variable code mapping for ID=${id}`,
  )
  return []
}

function processValues(variableRecord, graph) {
  const varRecordId = variableRecord['@id']
  const varIdsWithoutNotation = [datumCatVarId]
  return variableRecord.member.map(memberId => {
    const memberRecord = getEntityFromGraph(graph, memberId)
    if (!memberRecord) {
      throw new Error(`Could not find record with @id=${memberId}`)
    }
    const isWithoutNotation = varIdsWithoutNotation.includes(varRecordId)
    const code = isWithoutNotation ? memberRecord.label : memberRecord.notation
    if (!code) {
      sentryWarn(
        `Missing code for member ID=${memberId} as part of variable with ` +
          `ID=${varRecordId}`,
      )
    }
    return {
      code,
      label: memberRecord.label,
      definition: memberRecord.definition,
    }
  })
}

function getEntityFromGraph(graph, entityId) {
  return graph.find(e => e['@id'] === entityId)
}

if (sentryDsn) {
  // must be defined after all controllers
  app.use(Sentry.Handlers.errorHandler())
}

app.listen(port, () => {
  logger.info(`Ausplots metadata dictionary server running!
    Listening on port:    ${port}
    Cache expiry seconds: ${cacheExpirySeconds}
    Source URL:           ${jsonLdSourceUrl}
    Cat var container ID: ${categoricalVariablesContainerId}
    Sentry DSN:           ${sentryDsn}`)
})

function sentryWarn(msg) {
  logger.warn(msg)
  Sentry.withScope(scope => {
    scope.setLevel('warning')
    Sentry.captureException(msg)
  })
}
