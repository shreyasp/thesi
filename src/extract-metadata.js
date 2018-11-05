/* globals NSPredicate */
/* eslint no-bitwise: [2, {allow: ["|", "&"]}] */
import fs from '@skpm/fs'
import path from '@skpm/path'
import util from '@skpm/util'
import async from 'async'
import _ from 'lodash'
import sketch from 'sketch'
import fetch from 'sketch-polyfill-fetch'
import sketchDOM from 'sketch/dom'
import UI from 'sketch/ui'

function generateUUID() {
  let d = new Date().getTime()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (d + Math.random() * 16) % 16 | 0
    d = Math.floor(d / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function exportPNG(image, suffix, fileHash, options) {
  const defaultOptions = {
    formats: 'png',
    scale: '1',
    'save-for-web': true,
    output: `/tmp/thesi/${fileHash}/images/${suffix}`,
    'use-id-for-name': true,
  }

  defaultOptions['save-for-web'] = !!options && options.formats === 'png'
  sketchDOM.export(image, _.merge(defaultOptions, options))
}

// This function is kind of niche extraction function written specifically
// for purpose of extracting fonts as at present sketch-api objects don't
// expose font attributes of text layer directly.
function extractLayerFontData(layer) {
  // Specific to MacOS
  const predicate = NSPredicate.predicateWithFormat(
    'objectID CONTAINS[c] %@',
    layer.id
  )

  // HACK or NOTE:
  // Following call will do extraction of MSTextLayerObject from the sketchObject using class
  // NSPredicate available in Obj-C for fetching objects using specified filters.This returns
  // single element array per layer.id and so, we use zero'th element to show the fetched obj
  // as dictionary or JSON.
  const layerChildren = layer.sketchObject.children()
  const filteredObject = layerChildren
    .filteredArrayUsingPredicate(predicate)[0]
    .treeAsDictionary()
  const layerFontObject =
    filteredObject.attributedString.value.attributes[0].NSFont.attributes

  return {
    fontName: util.toJSObject(layerFontObject.NSFontNameAttribute),
    fontSize: util.toJSObject(layerFontObject.NSFontSizeAttribute),
  }
}

function extractImageMetaData(layer, parent, fileHash) {
  const frameKeys = ['height', 'width', 'x', 'y']
  const imageStyleKeys = ['opacity']
  const imageMetaObject = {}

  imageMetaObject.frame = _.pick(layer.frame, frameKeys)
  imageMetaObject.style = _.pick(layer.style, imageStyleKeys)
  imageMetaObject.layerParent = parent
  imageMetaObject.type = 'image'
  exportPNG(layer, 'background', fileHash)

  return {
    [_.snakeCase(layer.name)]: imageMetaObject,
  }
}

function extractTextMetadata(layer, parentName, parentFrame) {
  const frameKeys = ['height', 'width', 'x', 'y']
  const textStyleKeys = ['opacity']
  const frame = {}
  const layerFrame = _.pick(layer.frame, frameKeys)

  // NOTE: Since all the children layers display the frame based
  // on the parent layer. We need to compute actual position for
  // the layer in page by transforming local co-ordinates to the
  // page co-ordinates
  frame.x = parentFrame.x + layer.frame.asCGRect().origin.x
  frame.y = parentFrame.y + layer.frame.asCGRect().origin.y
  frame.width = layerFrame.width
  frame.height = layerFrame.height

  const textLayerMeta = {
    alignment: layer.alignment,
    style: _.pick(layer.style, textStyleKeys),
    text: layer.text,
    font: extractLayerFontData(layer),
    layerParent: parentName,
    type: 'text',
    frame,
  }

  textLayerMeta.style.color = _.get(layer, 'style.fills[0].color')
  return {
    [_.snakeCase(layer.name)]: textLayerMeta,
  }
}

function extractMetaData(layer, parentName, parentFrame, fileHash) {
  /*
    Keys required to be extracted from the text layer
    Text Layer
        |-  alignment
        |-  frame
            |- height
            |- width
            |- x
            |- y
        |-  name
        |-  style
            |-  opacity
            |-  fills
                |- color
        |-  text

    -----------------------------------------------
    Keys required to be extracted from the image layer
    Image Layer
        |- name
        |- frame
            |- height
            |- width
            |- x
            |- y
        |- image (to be exported directly as PNG)
        |- style (optional)
  */
  const data = {}

  // Removing any dashes, underscores or spaces from the layer name
  // and converting it to camelCased key for preventing any issues
  // while saving to database :)

  if (layer.type === 'Image') {
    _.assign(data, extractImageMetaData(layer, parentName, fileHash))
  } else if (layer.type === 'Text') {
    _.assign(data, extractTextMetadata(layer, parentName, parentFrame))
  }

  return data
}

// Entry Point for the Plugin
export default function(context) {
  // Get wrapped native Document object from Context
  const doc = sketch.fromNative(context.document)
  const page = doc && doc.selectedPage
  const fileHash = generateUUID()
  const baseURL = 'https://status-node-api.shreyasp.com/'
  const layerMetaObj = {}

  async.auto(
    {
      getCategories: getCategoryCB => {
        fetch(`${baseURL}/category/`)
          .then(response => response.json())
          .then(data => getCategoryCB(null, data))
          .catch(err => getCategoryCB(err))
      },
      getSelectedCategory: [
        'getCategories',
        (results, getSelCategoryCB) => {
          const categories = _.map(results.getCategories, o => o.displayName)
          const selection = UI.getSelectionFromUser(
            'Please select a category for the template',
            categories
          )

          // NOTE: Selection is an array of size 3
          // selection[0] === Response Code NSAlertFirstButtonReturn or NSAlertSecondButtonReturn
          // selection[1] === index of selected option
          // selection[2] === whether user clicked on Ok or Cancel button on the dialog
          if (!selection[2]) {
            getSelCategoryCB({
              break: true,
              error: false,
            })
          }

          const selectedCategory = categories[selection[1]]
          getSelCategoryCB(
            null,
            _.filter(
              results.getCategories,
              o => o.displayName === selectedCategory
            )
          )
        },
      ],
      getImageName: [
        'getSelectedCategory',
        (results, getImageNameCB) => {
          const imageName = UI.getStringFromUser(
            'Please enter unique name for the template: ',
            'Template Image Name'
          )
          getImageNameCB(null, {
            imageName,
          })
        },
      ],
      extractTemplateData: extractTemplDataCB => {
        // Hierarchy for extraction
        // Doc -> Page -> Layer/Artboard -> Layer-Group -> Layer -> Metadata
        _.forEach(page.layers, board => {
          _.forEach(board.layers, layerGroup => {
            const parentName = layerGroup.name

            // Actual co-ordinates based on page origin
            const parentFrame = _.pick(layerGroup.frame.toJSON(), ['x', 'y'])

            async.each(
              layerGroup.layers,
              layer => {
                _.assign(
                  layerMetaObj,
                  extractMetaData(layer, parentName, parentFrame, fileHash)
                )
              },
              err => {
                if (err) {
                  extractTemplDataCB(err)
                }
              }
            )
          })
        })

        // NOTE: Collect unique fonts required by the template
        const fonts = _.uniq(
          _.map(
            _.filter(layerMetaObj, o => o.type === 'text'),
            l => l.font.fontName
          )
        )

        // Save the template as PNG
        exportPNG(page, 'template', fileHash)
        extractTemplDataCB(null, {
          layerMetaObj,
          fonts,
        })
      },
      getTemplateFonts: [
        'extractTemplateData',
        (results, getTemplFontsCB) => {
          getTemplFontsCB(null, results.extractTemplateData.layerMetaObj)
        },
      ],
    },
    Infinity,
    (err, results) => {
      if (err) {
        if (err.break)
          context.document.showMessage('Template Extraction was aborted')
      } else {
        // Note: Propogate the filehash to next function for picking up proper
        // files from the directory
        context.document.showMessage('Extracted layer metadata successfully 😎')
        context.document.showMessage(results)
      }
    }
  )
  // NOTE: For now we are saving the JSON in temporary path
  // in future this would be feed to function call.
  const jsonPath = path.join('/tmp/thesi', `${fileHash}.json`)
  fs.writeFileSync(jsonPath, JSON.stringify(layerMetaObj))
}
