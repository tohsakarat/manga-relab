/* Generated from all JSON files in src/pipelines; run npm run build:pipelines to update. */
'use strict';
const PreinstalledPipelines = (() => {
  const definitions = [
  {
    "format": "screenlab-pipeline",
    "version": 1,
    "name": "标准修复流水线",
    "graph": {
      "nodes": {
        "14263940-a7ee-4033-8abd-7340195e9bf3": {
          "id": "14263940-a7ee-4033-8abd-7340195e9bf3",
          "type": "input",
          "name": "输入",
          "x": -162.44516503906155,
          "y": 162.59766992187508,
          "params": {}
        },
        "0c54d63b-79f6-46ef-ba79-22dd49dc4941": {
          "id": "0c54d63b-79f6-46ef-ba79-22dd49dc4941",
          "type": "output",
          "name": "输出",
          "x": 1570,
          "y": 180,
          "params": {},
          "outputMode": "directory",
          "directoryName": ""
        },
        "58e753a3-5cc1-40b0-9e5f-1c28cc409431": {
          "id": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
          "type": "denoise",
          "name": "降噪",
          "x": 302.56941706009013,
          "y": 105.42397063245187,
          "params": {
            "patch": 4,
            "search": 12,
            "strength": 25
          }
        },
        "229fdc1c-c69d-4f09-bf1c-5377bec70e24": {
          "id": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
          "type": "spine",
          "name": "去阴影",
          "x": 680.1880011211025,
          "y": 152.83197272028264,
          "params": {
            "scalePercent": 13.6,
            "strength": 100,
            "position": "unspecified"
          }
        },
        "5907a428-aa53-44e2-b208-e7e35d9befe8": {
          "id": "5907a428-aa53-44e2-b208-e7e35d9befe8",
          "type": "sharpen",
          "name": "USM 锐化",
          "x": 970,
          "y": 180,
          "params": {
            "amount": 100,
            "radiusPercent": 10,
            "threshold": 0
          }
        },
        "2d30f25a-b4e6-4057-9205-b4d5a0453959": {
          "id": "2d30f25a-b4e6-4057-9205-b4d5a0453959",
          "type": "curve",
          "name": "曲线",
          "x": 1269.282428886698,
          "y": 182.15274983894642,
          "params": {
            "points": [
              {
                "x": 0,
                "y": 0
              },
              {
                "x": 119,
                "y": 0
              },
              {
                "x": 241,
                "y": 255
              },
              {
                "x": 255,
                "y": 255
              }
            ]
          }
        }
      },
      "edges": [
        {
          "id": "a0d2e285-2c14-49a7-9841-77495e1eb7c5",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "image"
          },
          "to": {
            "nodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
            "port": "image"
          }
        },
        {
          "id": "1d48c5c6-40b1-45d2-8500-7d09563b6b21",
          "from": {
            "nodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
            "port": "image"
          },
          "to": {
            "nodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
            "port": "image"
          }
        },
        {
          "id": "e2b20334-32a6-4efd-a8ce-e4fa3315a989",
          "from": {
            "nodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
            "port": "image"
          },
          "to": {
            "nodeId": "5907a428-aa53-44e2-b208-e7e35d9befe8",
            "port": "image"
          }
        },
        {
          "id": "dd125771-2234-4d83-9e46-6d0fb6f48246",
          "from": {
            "nodeId": "5907a428-aa53-44e2-b208-e7e35d9befe8",
            "port": "image"
          },
          "to": {
            "nodeId": "2d30f25a-b4e6-4057-9205-b4d5a0453959",
            "port": "image"
          }
        },
        {
          "id": "865dcde8-ed03-42cc-aa27-f64d289608ce",
          "from": {
            "nodeId": "2d30f25a-b4e6-4057-9205-b4d5a0453959",
            "port": "image"
          },
          "to": {
            "nodeId": "0c54d63b-79f6-46ef-ba79-22dd49dc4941",
            "port": "image"
          }
        },
        {
          "id": "013379f5-2974-48ad-bb27-f7973dfbb5a5",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "c1e93038-3e7f-44d2-b40e-8908e60aae62"
          },
          "to": {
            "nodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
            "port": "patch"
          }
        },
        {
          "id": "f5e1357c-4172-4eff-afc9-d53f68539a8f",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "a1dbb03b-a004-4f15-9234-1c5e07d734cb"
          },
          "to": {
            "nodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
            "port": "search"
          }
        },
        {
          "id": "5a241720-9331-40f4-b781-505c19cd5c41",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "bb439749-9b39-4b78-8a76-edb673ba8d86"
          },
          "to": {
            "nodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
            "port": "strength"
          }
        },
        {
          "id": "a5b78de5-1803-4ed5-8b98-07936cc6d239",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "16445ebd-1a96-4074-9e38-f1ed9c36d664"
          },
          "to": {
            "nodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
            "port": "scalePercent"
          }
        },
        {
          "id": "8d3e3b92-f760-414b-8ef5-7c502eed8d66",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "ebf36720-72fe-4237-9a75-d3d26239b43b"
          },
          "to": {
            "nodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
            "port": "strength"
          }
        },
        {
          "id": "cd232a9b-7fed-429d-a5c7-6c234099f786",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "ad30c9b8-15cc-43c9-960e-5e9079aa4a53"
          },
          "to": {
            "nodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
            "port": "position"
          }
        },
        {
          "id": "8f125e1e-a59d-4b79-bce1-67fb1b1f2f19",
          "from": {
            "nodeId": "14263940-a7ee-4033-8abd-7340195e9bf3",
            "port": "bad7c903-d49a-4ac6-ac72-37037636fdc9"
          },
          "to": {
            "nodeId": "2d30f25a-b4e6-4057-9205-b4d5a0453959",
            "port": "points"
          }
        }
      ],
      "exposedVars": [
        {
          "variableId": "c1e93038-3e7f-44d2-b40e-8908e60aae62",
          "sourceNodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
          "paramKey": "patch",
          "displayName": "降噪.图块半径",
          "defaultValue": 3,
          "spec": {
            "key": "patch",
            "label": "图块半径",
            "type": "integer",
            "min": 2,
            "max": 8,
            "step": 1,
            "default": 4
          }
        },
        {
          "variableId": "a1dbb03b-a004-4f15-9234-1c5e07d734cb",
          "sourceNodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
          "paramKey": "search",
          "displayName": "降噪.搜索半径",
          "defaultValue": 8,
          "spec": {
            "key": "search",
            "label": "搜索半径",
            "type": "integer",
            "min": 4,
            "max": 24,
            "step": 1,
            "default": 12
          }
        },
        {
          "variableId": "bb439749-9b39-4b78-8a76-edb673ba8d86",
          "sourceNodeId": "58e753a3-5cc1-40b0-9e5f-1c28cc409431",
          "paramKey": "strength",
          "displayName": "降噪.匹配容差",
          "defaultValue": 80,
          "spec": {
            "key": "strength",
            "label": "匹配容差",
            "type": "number",
            "min": 5,
            "max": 80,
            "step": 1,
            "default": 25
          }
        },
        {
          "variableId": "16445ebd-1a96-4074-9e38-f1ed9c36d664",
          "sourceNodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
          "paramKey": "scalePercent",
          "displayName": "去阴影.阴影尺度（页面宽度 %）",
          "defaultValue": 13.6,
          "spec": {
            "key": "scalePercent",
            "label": "阴影尺度（页面宽度 %）",
            "type": "number",
            "min": 0,
            "max": 30,
            "step": 0.1,
            "default": 5
          }
        },
        {
          "variableId": "ebf36720-72fe-4237-9a75-d3d26239b43b",
          "sourceNodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
          "paramKey": "strength",
          "displayName": "去阴影.校正强度（%）",
          "defaultValue": 100,
          "spec": {
            "key": "strength",
            "label": "校正强度（%）",
            "type": "number",
            "min": 0,
            "max": 100,
            "step": 1,
            "default": 100
          }
        },
        {
          "variableId": "ad30c9b8-15cc-43c9-960e-5e9079aa4a53",
          "sourceNodeId": "229fdc1c-c69d-4f09-bf1c-5377bec70e24",
          "paramKey": "position",
          "displayName": "去阴影.阴影位置",
          "defaultValue": "unspecified",
          "spec": {
            "key": "position",
            "label": "阴影位置",
            "type": "enum",
            "values": [
              "center",
              "left",
              "right",
              "top",
              "bottom",
              "unspecified"
            ],
            "default": "unspecified"
          }
        },
        {
          "variableId": "bad7c903-d49a-4ac6-ac72-37037636fdc9",
          "sourceNodeId": "2d30f25a-b4e6-4057-9205-b4d5a0453959",
          "paramKey": "points",
          "displayName": "曲线.曲线点",
          "defaultValue": [
            {
              "x": 0,
              "y": 0
            },
            {
              "x": 119,
              "y": 0
            },
            {
              "x": 241,
              "y": 255
            },
            {
              "x": 255,
              "y": 255
            }
          ],
          "spec": {
            "key": "points",
            "label": "曲线点",
            "type": "json",
            "range": "array of {x,y}: integer 0..255; x strictly ascending; first x=0, last x=255",
            "default": [
              {
                "x": 0,
                "y": 0
              },
              {
                "x": 255,
                "y": 255
              }
            ]
          }
        }
      ],
      "view": {
        "x": 676.4860322331208,
        "y": -91.09043733655744,
        "zoom": 1.2636175712482376
      }
    }
  }
];

  function createCopies() {
    return definitions.map(definition =>
      Store.pipelines.create(definition.name, Graph.importDefinition(definition)));
  }

  return { createCopies };
})();
