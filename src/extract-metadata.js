/* globals NSPredicate */
import async from 'async'
import _ from 'lodash'
import sketch from 'sketch'
import sketchDOM from 'sketch/dom'

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
    fontName: layerFontObject.NSFontNameAttribute,
    fontSize: layerFontObject.NSFontSizeAttribute,
  }
}

function extractImageMetaData(layer, parent) {
  const frameKeys = ['height', 'width', 'x', 'y']
  const imageStyleKeys = ['opacity']
  const imageMetaObject = {}

  imageMetaObject.frame = _.pick(layer.frame, frameKeys)
  imageMetaObject.style = _.pick(layer.style, imageStyleKeys)
  imageMetaObject.layerParent = parent
  exportPNG(layer)

  return imageMetaObject
}

function extractTextMetadata(layer, parent) {
  const frameKeys = ['height', 'width', 'x', 'y']
  const textStyleKeys = ['opacity']

  const textLayerMeta = {
    alignment: layer.alignment,
    frame: _.pick(layer.frame, frameKeys),
    style: _.pick(layer.style, textStyleKeys),
    text: layer.text,
    font: extractLayerFontData(layer),
    layerParent: parent,
  }
  textLayerMeta.style.color = _.get(layer, 'style.fills[0].color')

  return textLayerMeta
}

function extractMetaData(layer, parent) {
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
  const layerName = _.camelCase(layer.name)

  if (layer.type === 'Image') {
    data[layerName] = extractImageMetaData(layer, parent)
  } else if (layer.type === 'Text') {
    data[layerName] = extractTextMetadata(layer, parent)
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
      const parent = layerGroup.name
      async.each(
        layerGroup.layers,
        layer => {
          layerMetaArr.push(extractMetaData(layer, parent))
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
  context.document.showMessage('Extracted layer metadata successfully 😎')
}
