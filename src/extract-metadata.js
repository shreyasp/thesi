/* globals NSPredicate NSData */
/* eslint no-bitwise: [2, {allow: ["|", "&"]}] */
import fs from '@skpm/fs'
import path from '@skpm/path'
import util from '@skpm/util'
import async from 'async'
import _ from 'lodash'
import sketch from 'sketch'
import fetch from 'sketch-polyfill-fetch'
import FormData from 'sketch-polyfill-fetch/lib/form-data'
import UI from 'sketch/ui'

function checkStatus(response) {
  if (response.ok) {
    return response
  }
  const error = new Error(response.statusText)
  error.response = response
  return Promise.reject(error)
}

function generateUUID() {
  let d = new Date().getTime()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (d + Math.random() * 16) % 16 | 0
    d = Math.floor(d / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

function exportImage(image, suffix, fileHash, options) {
  const defaultOptions = {
    formats: 'jpg',
    scale: '1',
    compression: 0.9,
    progressive: true,
    output: `/tmp/thesi/${fileHash}/images/${suffix}`,
    'use-id-for-name': true,
  }

  sketch.export(image, _.merge(defaultOptions, options))
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
  exportImage(layer, 'background', fileHash)

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
    alignment: layer.style.alignment,
    style: _.pick(layer.style, textStyleKeys),
    text: layer.text,
    font: extractLayerFontData(layer),
    layerParent: parentName,
    type: 'text',
    frame,
  }

  textLayerMeta.style.color = _.isEmpty(layer.style.fills)
    ? _.get(layer, 'style.textColor')
    : _.get(layer, 'style.fills[0].color')
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
  const doc = sketch.getSelectedDocument()
  const page = doc && doc.selectedPage
  const fileHash = generateUUID()
  const baseURL = 'https://status-node-api.shreyasp.com'
  const layerMetaObj = {}

  async.auto(
    {
      getCategories: getCategoryCB => {
        fetch(`${baseURL}/category/`)
          .then(checkStatus)
          .then(response => response.json())
          .then(jsonResponse =>
            getCategoryCB(null, jsonResponse.data.categories)
          )
          .catch(err => {
            getCategoryCB(err)
          })
      },
      getSelectedCategory: [
        'getCategories',
        (results, getSelCategoryCB) => {
          const categories = _.map(results.getCategories, o => o.displayName)
          UI.getInputFromUser(
            'Please select a category for the template',
            {
              type: UI.INPUT_TYPE.selection,
              possibleValues: categories,
            },
            (err, selection) => {
              if (err) {
                return
              } else if (!selection) {
                getSelCategoryCB({
                  break: true,
                  error: false,
                })
              }

              getSelCategoryCB(
                null,
                _.filter(
                  results.getCategories,
                  o => o.displayName === selection
                )
              )
            }
          )
        },
      ],
      getImageName: [
        'getSelectedCategory',
        (results, getImageNameCB) => {
          UI.getInputFromUser(
            'Please enter unique name for the template',
            {
              type: UI.INPUT_TYPE.string,
              initialValue: 'Template_Image_Name (Do not use spaces)',
            },
            (err, imageName) => {
              getImageNameCB(null, {
                imageName,
              })
            }
          )
        },
      ],
      extractTemplateData: [
        'getImageName',
        (results, extractTemplDataCB) => {
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
          exportImage(page.layers, 'template', fileHash)
          extractTemplDataCB(null, {
            layerMetaObj,
            fonts,
          })
        },
      ],
      getFontPath: [
        'extractTemplateData',
        (results, getFontPathCB) => {
          UI.getInputFromUser(
            'Please specify the path to fonts folder',
            {
              type: UI.INPUT_TYPE.string,
              initialValue: '/path/to/fonts/folder',
            },
            (err, fontPath) => {
              try {
                fs.accessSync(fontPath)
              } catch (inErr) {
                UI.alert(
                  'Font Path Error',
                  "Specified font path doesn't exist. Please restart and input correct font path"
                )
                getFontPathCB(inErr)
              }

              const fontToUpload = []
              const expectedFonts = results.extractTemplateData.fonts
              const fontFiles = fs.readdirSync(fontPath)

              _.forEach(fontFiles, file => {
                const fontName = path.parse(file).name
                if (
                  _.indexOf(results.extractTemplateData.fonts, fontName) !== -1
                ) {
                  fontToUpload.push(path.join(fontPath, file))
                  _.pull(expectedFonts, fontName)
                }
              })

              if (!_.isEmpty(fontToUpload) && _.isEmpty(expectedFonts)) {
                getFontPathCB(null, { paths: fontToUpload })
              } else {
                UI.alert(
                  'Font missing',
                  `Specified fonts are missing: [${expectedFonts}]`
                )
                getFontPathCB({ break: true })
              }
            }
          )
        },
      ],
      createImage: [
        'getSelectedCategory',
        'getImageName',
        (results, createImageCB) => {
          const fetchOptions = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              imageName: results.getImageName.imageName,
              categoryId: results.getSelectedCategory[0].id,
            }),
          }

          fetch(`${baseURL}/image/`, fetchOptions)
            .then(checkStatus)
            .then(response => response.json())
            .then(data => createImageCB(null, data))
            .catch(err => createImageCB(err))
        },
      ],
      uploadTemplate: [
        'createImage',
        (results, uploadTemplateCB) => {
          try {
            const templatePath = path.join(
              '/tmp',
              'thesi',
              fileHash,
              'images',
              'template'
            )
            const templates = fs.readdirSync(templatePath)
            const filePath = path.join(templatePath, templates[0])
            const binaryData = NSData.alloc().initWithContentsOfFile(filePath)

            const formData = new FormData()
            formData.append('template', {
              fileName: templates[0],
              mimeType: 'image/jpeg',
              data: binaryData,
            })

            const fetchOptions = {
              method: 'PUT',
              body: formData,
            }

            fetch(
              `${baseURL}/image/${results.createImage.id}/template/${fileHash}`,
              fetchOptions
            )
              .then(checkStatus)
              .then(response => response.json())
              .then(data => uploadTemplateCB(null, data))
              .catch(err => uploadTemplateCB(err))
          } catch (err) {
            uploadTemplateCB(err)
          }
        },
      ],
      uploadTemplateBackground: [
        'createImage',
        (results, uploadTemplBackgroundCB) => {
          try {
            const templateBckgndPath = path.join(
              '/tmp',
              'thesi',
              fileHash,
              'images',
              'background'
            )
            const templBackground = fs.readdirSync(templateBckgndPath)
            const filePath = path.join(templateBckgndPath, templBackground[0])
            const binaryData = NSData.alloc().initWithContentsOfFile(filePath)

            const formData = new FormData()
            formData.append('background', {
              fileName: templBackground[0],
              mimeType: 'image/jpeg',
              data: binaryData,
            })

            const fetchOptions = {
              method: 'PUT',
              body: formData,
            }

            fetch(
              `${baseURL}/image/${
                results.createImage.id
              }/background/${fileHash}`,
              fetchOptions
            )
              .then(checkStatus)
              .then(response => response.json())
              .then(data => uploadTemplBackgroundCB(null, data))
              .catch(err => uploadTemplBackgroundCB(err))
          } catch (err) {
            uploadTemplBackgroundCB(err)
          }
        },
      ],
      uploadLayerMeta: [
        'createImage',
        (results, uploadLayerMetaCB) => {
          const fetchOptions = {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(results.extractTemplateData.layerMetaObj),
          }

          fetch(`${baseURL}/layer/${results.createImage.id}`, fetchOptions)
            .then(checkStatus)
            .then(response => response.json())
            .then(data => uploadLayerMetaCB(null, data))
            .catch(err => uploadLayerMetaCB(err))
        },
      ],
      uploadLayerFonts: [
        'uploadLayerMeta',
        (results, uploadLayerFontsCB) => {
          const formData = new FormData()
          _.forEach(results.getFontPath.paths, fontPath => {
            const mimeType =
              path.parse(fontPath).ext === 'ttf' ||
              path.parse(fontPath).ext === 'ttc'
                ? 'application/x-font-truetype'
                : 'application/x-font-opentype'
            formData.append('font', {
              data: NSData.alloc().initWithContentsOfFile(fontPath),
              mimeType,
              fileName: path.parse(fontPath).base,
            })
          })

          const fetchOptions = {
            method: 'POST',
            body: formData,
          }

          fetch(`${baseURL}/font/`, fetchOptions)
            .then(checkStatus)
            .then(response => response.json())
            .then(data => uploadLayerFontsCB(null, data))
            .catch(err => uploadLayerFontsCB(err))
        },
      ],
      cleanUpTemplateData: [
        'uploadTemplate',
        'uploadTemplateBackground',
        (results, cleanUpCB) => {
          try {
            fs.rmdirSync(path.join('/tmp', 'thesi', `${fileHash}`))
            cleanUpCB(null, {
              sucess: true,
              message: 'Cleaned up template images',
            })
          } catch (err) {
            cleanUpCB(err)
          }
        },
      ],
    },
    Infinity,
    (err, results) => {
      // TODO: Still to write logs for success and failure.
      JSON.stringify(results)
      if (err) {
        if (err.break) {
          context.document.showMessage('Template Extraction was aborted 🚫')
        } else {
          UI.alert(
            'Failure',
            'Something went wrong while trying to extracting or uploading'
          )
          context.document.showMessage(
            'Something went wrong while extracting 🤯'
          )
        }
      } else {
        UI.alert(
          'Success',
          'Template was extracted and uploaded successfully to the server'
        )
        context.document.showMessage('Extracted layer metadata successfully 😎')
      }
    }
  )
}
