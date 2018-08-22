/* globals NSPredicate */
import async from 'async'
import _ from 'lodash'
import sketch from 'sketch'
import sketchDOM from 'sketch/dom'
import fs from '@skpm/fs'
import path from '@skpm/path'
import util from '@skpm/util'

function exportPNG(image, options) {
  const defaultOptions = {
    formats: 'png',
    scale: '1',
    'save-for-web': true,
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

function extractImageMetaData(layer, parent) {
  const frameKeys = ['height', 'width', 'x', 'y']
  const imageStyleKeys = ['opacity']
  const imageMetaObject = {}

  imageMetaObject.frame = _.pick(layer.frame, frameKeys)
  imageMetaObject.style = _.pick(layer.style, imageStyleKeys)
  imageMetaObject.layerParent = parent
  imageMetaObject.type = 'image'
  imageMetaObject.name = _.snakeCase(layer.name)
  exportPNG(layer)

  return imageMetaObject
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
  frame.x = parentFrame.x + layerFrame.x
  frame.y = parentFrame.y + layerFrame.y

  const textLayerMeta = {
    alignment: layer.alignment,
    style: _.pick(layer.style, textStyleKeys),
    text: layer.text,
    font: extractLayerFontData(layer),
    layerParent: parentName,
    type: 'text',
    name: _.snakeCase(layer.name),
    frame,
  }

  textLayerMeta.style.color = _.get(layer, 'style.fills[0].color')
  return textLayerMeta
}

function extractMetaData(layer, parentName, parentFrame) {
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
  // const layerName = _.camelCase(layer.name)

  if (layer.type === 'Image') {
    _.assign(data, extractImageMetaData(layer, parentName))
  } else if (layer.type === 'Text') {
    _.assign(data, extractTextMetadata(layer, parentName, parentFrame))
  }

  return data
}

// Entry Point for the Plugin
export default function(context) {
  // Get wrapped native Document object from Context
  const doc = sketch.fromNative(context.document)
  const page = doc.selectedPage

  // Hierarchy for extraction
  // Doc -> Page -> Layer/Artboard -> Layer-Group -> Layer -> Metadata
  const layerMetaArr = []
  _.forEach(page.layers, board => {
    _.forEach(board.layers, layerGroup => {
      const parentName = layerGroup.name

      // Actual co-ordinates based on page origin
      const parentFrame = _.pick(layerGroup.frame.toJSON(), ['x', 'y'])

      async.each(
        layerGroup.layers,
        layer => {
          layerMetaArr.push(extractMetaData(layer, parentName, parentFrame))
        },
        err => {
          if (err) {
            context.document.showMessage(err.message)
          }
        }
      )
    })
  })

  // Save the template as PNG
  exportPNG(page)

  // NOTE: For now we are saving the JSON in temporary path
  // in future this would be feed to function call.
  const jsonPath = path.join('/tmp', 'meta.json')
  fs.writeFileSync(jsonPath, JSON.stringify(layerMetaArr))

  context.document.showMessage('Extracted layer metadata successfully 😎')
}
